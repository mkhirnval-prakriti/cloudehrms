/**
 * Payroll Engine V2 — fixed-monthly-salary policy.
 *
 *   1. Salary is FIXED per month — month-length doesn't change payout
 *      (₹12,000 in Feb (28d) and July (31d) is still ₹12,000 minus deductions).
 *   2. Per-day rate = monthly_salary / days_in_month — used ONLY for
 *      computing per-day deductions, never as the payout base.
 *   3. Half-day = 0.5 day salary deducted ALWAYS (no free half-day).
 *   4. Combined leave count = absent + week_off + (half_day * 0.5).
 *      Default 4 leaves/month allowed. Excess → per-day deduction.
 *   5. Working hours rule: if a present-day's worked hours < employee's
 *      min_working_hours AND auto_half_day_enabled, day → half-day.
 *      Per-employee min hours: users.min_working_hours_override
 *      → falls back to (shift_end - shift_start) → falls back to policy default.
 *   6. Special holidays (payroll_special_holidays) → paid, no deduction
 *      even if employee was absent that day.
 *   7. Late penalty: minutes past shift_start beyond grace+threshold
 *      → optional half-day-equivalent deduction (policy-driven).
 *   8. Manual override: admin can set the final salary directly.
 *
 * All knobs live in `payroll_policy_v2` (in integration_kv).
 */

function round2(x) { return Math.round(Number(x) * 100) / 100; }
function roundInr(x) { return Math.round(Number(x) || 0); }

function defaultPayrollPolicy() {
  return {
    monthly_leave_limit: 4,
    half_day_unit: 0.5,
    // Dynamic rate model:
    //   per_day_salary = monthly_salary ÷ per_day_divisor (default 30)
    //   half_day_amount = per_day × half_day_unit (default 0.5)
    //   excess_leave_deduction = excess × per_day
    //   unused_leave_bonus     = unused × per_day  (if bonus_enabled)
    //   late_deduction         = late_days × per_day × late_penalty_unit (if enabled)
    per_day_divisor: 30,
    bonus_enabled: true,
    min_working_hours: 8,
    auto_half_day_enabled: true,
    half_day_counts_in_leave: true,
    weekoff_counts_in_leave: false,
    late_minutes_threshold: 0,         // per-day grace (above shift_start+grace)
    late_deduction_enabled: true,
    // Minutes-based monthly late penalty:
    //   First `late_free_minutes` of accumulated lateness in a month → free
    //   Every additional `late_block_minutes` → `late_block_days` day cut
    //   Default: free 30 min, then every 30 min = 1 day cut
    //   Examples: 30→0, 31→1, 60→1, 61→2, 91→3
    late_free_minutes: 30,
    late_block_minutes: 30,
    late_block_days: 1,
    company_name: "Your Company Name",
  };
}

function daysInMonth(period) {
  const [y, m] = String(period).split("-").map(Number);
  if (!y || !m) return 30;
  return new Date(y, m, 0).getDate();
}

/**
 * Minutes since midnight in IST (Asia/Kolkata) from a UTC ISO string.
 * Mirrors server/api.js::localMinutesFromDate to avoid TZ drift on server
 * (Replit runs in UTC; punch_in_at stored as UTC ISO).
 */
function istMinutesSinceMidnight(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  const istMs = d.getTime() + 5.5 * 3600000;
  const ist = new Date(istMs);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function shiftStartMinutes(user) {
  if (!user || !user.shift_start) return null;
  const [sh, sm] = String(user.shift_start).split(":").map(Number);
  if (Number.isNaN(sh)) return null;
  return (sh || 0) * 60 + (sm || 0);
}

function shiftDurationHours(user) {
  if (!user || !user.shift_start || !user.shift_end) return null;
  const [sh, sm] = String(user.shift_start).split(":").map(Number);
  const [eh, em] = String(user.shift_end).split(":").map(Number);
  if (Number.isNaN(sh) || Number.isNaN(eh)) return null;
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60; // overnight shift
  return mins / 60;
}

function effectiveMinHours(user, policy) {
  const override = user && user.min_working_hours_override;
  if (override != null && Number(override) > 0) return Number(override);
  const dur = shiftDurationHours(user);
  if (dur && dur > 0) return dur;
  return Number(policy.min_working_hours) || 8;
}

function loadSpecialHolidaysSet(db, period) {
  const rows = db.prepare(
    "SELECT holiday_date FROM payroll_special_holidays WHERE substr(holiday_date,1,7) = ?"
  ).all(period);
  return new Set(rows.map((r) => r.holiday_date));
}

/**
 * Aggregate one employee's month from attendance + leave + holidays.
 */
function aggregateMonthForUser(db, userId, period, policy, opts = {}) {
  const totalDays = daysInMonth(period);
  const monthStart = `${period}-01`;
  const monthEnd = `${period}-${String(totalDays).padStart(2, "0")}`;
  const specialHolidays = opts.specialHolidays || loadSpecialHolidaysSet(db, period);
  const user = opts.user
    || db.prepare("SELECT id, shift_start, shift_end, grace_minutes, min_working_hours_override FROM users WHERE id = ?").get(userId);
  const minHours = effectiveMinHours(user, policy);
  const autoHalf = !!policy.auto_half_day_enabled;
  const lateThreshold = Number(policy.late_minutes_threshold) || 30;

  const rows = db.prepare(
    `SELECT work_date, status, half_period, punch_in_at, punch_out_at
     FROM attendance_records
     WHERE user_id = ? AND work_date >= ? AND work_date <= ?`
  ).all(userId, monthStart, monthEnd);

  let presentDays = 0, halfDays = 0, absentDays = 0;
  let lowHoursDays = 0, lateDays = 0, totalLateMinutes = 0;
  const lateDates = []; // [{ date, punch_in, late_minutes }]

  for (const r of rows) {
    if (specialHolidays.has(r.work_date)) {
      // Treat as paid present — no deduction, count as present for clarity.
      presentDays += 1;
      continue;
    }
    const st = String(r.status || "").toLowerCase();
    let workedHours = 0;
    if (r.punch_in_at && r.punch_out_at) {
      workedHours = (new Date(r.punch_out_at) - new Date(r.punch_in_at)) / 3600000;
    }
    if (st === "absent" || st === "leave") {
      absentDays += 1;
      continue;
    }
    if (st === "half" || st === "half_day") {
      halfDays += 1;
      continue;
    }
    // Late check (only when we have a punch_in) — TZ-safe: compare
    // minutes-since-midnight in IST, not raw Date math.
    if (r.punch_in_at && user && user.shift_start) {
      const punchMin = istMinutesSinceMidnight(r.punch_in_at);
      const startMin = shiftStartMinutes(user);
      if (startMin != null) {
        const lateMins = punchMin - startMin - (Number(user.grace_minutes) || 0);
        if (lateMins > lateThreshold) {
          lateDays += 1;
          totalLateMinutes += lateMins;
          lateDates.push({ date: r.work_date, punch_in: r.punch_in_at, late_minutes: Math.round(lateMins) });
        }
      }
    }
    // Working-hours rule
    if (autoHalf && r.punch_in_at && r.punch_out_at && workedHours < minHours) {
      halfDays += 1;
      lowHoursDays += 1;
    } else {
      presentDays += 1;
    }
  }

  // Approved leaves overlapping this month (skip special-holiday dates).
  const datesWithRow = new Set(rows.map((r) => r.work_date));
  const leaves = db.prepare(
    `SELECT start_date, end_date FROM leave_requests
     WHERE user_id = ? AND final_status = 'APPROVED'
       AND start_date <= ? AND end_date >= ?`
  ).all(userId, monthEnd, monthStart);

  let leaveDaysApproved = 0;
  const leaveDateSet = new Set();
  for (const lv of leaves) {
    const start = new Date(Math.max(new Date(lv.start_date), new Date(monthStart)));
    const end = new Date(Math.min(new Date(lv.end_date), new Date(monthEnd)));
    for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
      const iso = d.toISOString().slice(0, 10);
      leaveDateSet.add(iso);
      if (specialHolidays.has(iso)) continue; // paid holiday — don't count leave
      leaveDaysApproved += 1;
      if (!datesWithRow.has(iso)) absentDays += 1;
    }
  }

  // Week-off detection: Sundays without any record/leave/holiday.
  let weekoffDays = 0;
  for (let day = 1; day <= totalDays; day++) {
    const iso = `${period}-${String(day).padStart(2, "0")}`;
    if (datesWithRow.has(iso) || leaveDateSet.has(iso) || specialHolidays.has(iso)) continue;
    const dt = new Date(`${iso}T00:00:00Z`);
    if (dt.getUTCDay() === 0) weekoffDays += 1;
  }

  let combined = absentDays;
  if (policy.half_day_counts_in_leave !== false) {
    combined += halfDays * (Number(policy.half_day_unit) || 0.5);
  }
  if (policy.weekoff_counts_in_leave !== false) {
    combined += weekoffDays;
  }

  return {
    present_days: presentDays,
    half_days: halfDays,
    absent_days: absentDays,
    weekoff_days: weekoffDays,
    leave_days_approved: leaveDaysApproved,
    combined_leave_units: round2(combined),
    low_hours_days: lowHoursDays,
    late_days: lateDays,
    total_late_minutes: Math.round(totalLateMinutes),
    late_dates: lateDates,
    special_holiday_count: specialHolidays.size,
    total_days_in_month: totalDays,
    effective_min_hours: minHours,
  };
}

/**
 * Dynamic compute (Monthly ÷ Divisor):
 *   per_day            = monthly ÷ per_day_divisor (default 30)
 *   half_day           = per_day × half_day_unit (default 0.5)
 *   excess_deduction   = max(0, combined - limit) × per_day
 *   unused_leave_bonus = max(0, limit - combined) × per_day  (if bonus_enabled)
 *   late_deduction     = late_days × per_day × late_penalty_unit (if enabled)
 *   final = monthly + bonus - half_day_cuts - excess - late
 *
 * Examples (₹12,000 monthly, divisor 30 → per_day ₹400, half ₹200, limit 4):
 *   5 leaves, 0 half:  12000 + 0 - 0 - 400 = ₹11,600  ✓
 *   3 leaves, 0 half:  12000 + 400 - 0 - 0 = ₹12,400  ✓
 *   0 leaves, 0 half:  12000 + 1600 - 0 - 0 = ₹13,600 ✓
 *   ₹15,000 monthly → per_day ₹500, 1 extra leave → 15000 - 500 = ₹14,500 ✓
 */
function computePayrollForUser({ monthlySalary, agg, policy, override }) {
  const policy_ = { ...defaultPayrollPolicy(), ...(policy || {}) };
  const base = Number(monthlySalary) || 0;
  const limit = Number(policy_.monthly_leave_limit) || 0;
  const divisor = Math.max(1, Number(policy_.per_day_divisor) || 30);
  const halfUnit = Number(policy_.half_day_unit) || 0.5;
  const lateFreeMin = Math.max(0, Number(policy_.late_free_minutes) || 0);
  const lateBlockMin = Math.max(1, Number(policy_.late_block_minutes) || 30);
  const lateBlockDays = Math.max(0, Number(policy_.late_block_days) || 1);

  const perDayRate = base / divisor;
  const halfDayRate = perDayRate * halfUnit;

  const halfDayDeduction = agg.half_days * halfDayRate;
  const excessLeaves = Math.max(0, agg.combined_leave_units - limit);
  const excessLeaveDeduction = excessLeaves * perDayRate;
  const unusedLeaves = Math.max(0, limit - agg.combined_leave_units);
  const bonus = policy_.bonus_enabled ? unusedLeaves * perDayRate : 0;

  // Minutes-based monthly late penalty:
  //   over = max(0, total_late_minutes - free_minutes)
  //   blocks = ceil(over / block_minutes)   (0 if over==0)
  //   Default free=30, block=30: 30→0, 31→1, 60→1, 61→2, 91→3
  const totalLateMin = Math.round(Number(agg.total_late_minutes) || 0);
  const lateOverMin = Math.max(0, totalLateMin - lateFreeMin);
  const latePenaltyBlocks = lateOverMin === 0 ? 0 : Math.ceil(lateOverMin / lateBlockMin);
  const latePenaltyDays = latePenaltyBlocks * lateBlockDays;
  const lateDeduction = policy_.late_deduction_enabled ? latePenaltyDays * perDayRate : 0;
  // For UI live tracker
  const lateRemainingSafeMin = Math.max(0, lateFreeMin - totalLateMin);
  const lateUntilNextBlockMin = lateOverMin === 0
    ? lateRemainingSafeMin + 1                       // mins until first deduction triggers
    : (lateBlockMin - ((lateOverMin - 1) % lateBlockMin)); // mins until next block triggers

  const totalDeduction = halfDayDeduction + excessLeaveDeduction + lateDeduction;

  let finalSalary = Math.max(0, base + bonus - totalDeduction);
  let manualOverride = false;
  if (override != null && override !== "" && !Number.isNaN(Number(override))) {
    finalSalary = Number(override);
    manualOverride = true;
  }

  return {
    monthly_salary: roundInr(base),
    days_in_month: agg.total_days_in_month,
    per_day_salary: roundInr(perDayRate),
    half_day_rate: roundInr(halfDayRate),
    half_day_count: agg.half_days,
    half_day_deduction_inr: roundInr(halfDayDeduction),
    combined_leave_units: agg.combined_leave_units,
    leave_limit: limit,
    excess_leaves: round2(excessLeaves),
    excess_leave_deduction_inr: roundInr(excessLeaveDeduction),
    unused_leaves: round2(unusedLeaves),
    unused_leave_bonus_inr: roundInr(bonus),
    late_days: agg.late_days || 0,
    late_dates: agg.late_dates || [],
    total_late_minutes: totalLateMin,
    late_free_minutes: lateFreeMin,
    late_block_minutes: lateBlockMin,
    late_block_days: lateBlockDays,
    late_penalty_blocks: latePenaltyBlocks,
    late_penalty_days: latePenaltyDays,
    late_remaining_safe_minutes: lateRemainingSafeMin,
    late_until_next_block_minutes: lateUntilNextBlockMin,
    late_deduction_inr: roundInr(lateDeduction),
    total_deduction_inr: roundInr(totalDeduction),
    final_salary_inr: roundInr(finalSalary),
    manual_override: manualOverride,
    breakdown: agg,
  };
}

module.exports = {
  defaultPayrollPolicy,
  daysInMonth,
  shiftDurationHours,
  shiftStartMinutes,
  istMinutesSinceMidnight,
  effectiveMinHours,
  loadSpecialHolidaysSet,
  aggregateMonthForUser,
  computePayrollForUser,
};
