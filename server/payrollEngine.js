/**
 * Payroll calculations: incentive, leave deduction, late penalty, final salary.
 */

function round2(x) {
  return Math.round(Number(x) * 100) / 100;
}

function defaultPayrollSettings() {
  return {
    default_salary: 12000,
    incentive_percent: 10,
    incentive_threshold_inr: 1000,
    leave_free_days: 4,
    late_minutes_threshold: 60,
    half_day_divisor: 60,
    no_leave_bonus_inr: 500,
    no_leave_bonus_enabled: false,
    company_name: "Your Company Name",
  };
}

function computeIncentive(deliveryAmount, s) {
  const d = Number(deliveryAmount) || 0;
  const threshold = Number(s.incentive_threshold_inr) || 1000;
  const pct = Number(s.incentive_percent) || 10;
  if (d <= threshold) return 0;
  return round2((d - threshold) * (pct / 100));
}

/** Paid leave: first N days free, then per-day rate. */
function computeLeaveDeductionPaid(totalLeaves, baseSalary, s) {
  const tl = Number(totalLeaves) || 0;
  const free = Number(s.leave_free_days) ?? 4;
  const extra = Math.max(0, tl - free);
  const perDay = (Number(baseSalary) || 0) / 30;
  return round2(extra * perDay);
}

/** Absent: no free days — all leave days deduct at per-day rate. */
function computeLeaveDeductionAbsent(totalLeaves, baseSalary) {
  const tl = Number(totalLeaves) || 0;
  const perDay = (Number(baseSalary) || 0) / 30;
  return round2(tl * perDay);
}

function computeLateDeduction(lateMinutes, baseSalary, s) {
  const lm = Number(lateMinutes) || 0;
  const th = Number(s.late_minutes_threshold) ?? 60;
  if (lm < th) return 0;
  const div = Number(s.half_day_divisor) ?? 60;
  if (!div || div <= 0) return 0;
  return round2((Number(baseSalary) || 0) / div);
}

/**
 * @param {object} opts
 * @param {number} opts.baseSalary
 * @param {number} opts.delivery_amount
 * @param {number} opts.total_leaves
 * @param {'paid'|'absent'} opts.leave_type
 * @param {number} opts.late_minutes
 * @param {object} opts.settings
 * @param {object} [opts.overrides] — optional manual values
 * @param {boolean} [opts.apply_no_leave_bonus]
 */
function computePayrollRow(opts) {
  const settings = { ...defaultPayrollSettings(), ...(opts.settings || {}) };
  const base = Number(opts.baseSalary) || 0;
  const delivery = opts.delivery_amount;
  const totalLeaves = opts.total_leaves;
  const leaveType = String(opts.leave_type || "paid").toLowerCase() === "absent" ? "absent" : "paid";
  const lateMinutes = opts.late_minutes;
  const o = opts.overrides || {};

  let incentive = computeIncentive(delivery, settings);
  if (o.incentive_inr != null && o.incentive_inr !== "") incentive = round2(Number(o.incentive_inr));

  let leaveDed =
    leaveType === "absent"
      ? computeLeaveDeductionAbsent(totalLeaves, base)
      : computeLeaveDeductionPaid(totalLeaves, base, settings);
  if (o.leave_deduction_inr != null && o.leave_deduction_inr !== "") leaveDed = round2(Number(o.leave_deduction_inr));

  let lateDed = computeLateDeduction(lateMinutes, base, settings);
  if (o.late_deduction_inr != null && o.late_deduction_inr !== "") lateDed = round2(Number(o.late_deduction_inr));

  let bonus = 0;
  const applyBonus = opts.apply_no_leave_bonus !== false;
  if (applyBonus && settings.no_leave_bonus_enabled && Number(totalLeaves) === 0) {
    bonus = round2(Number(settings.no_leave_bonus_inr) || 0);
  }
  if (o.no_leave_bonus_inr != null && o.no_leave_bonus_inr !== "") bonus = round2(Number(o.no_leave_bonus_inr));

  let final = base + incentive - leaveDed - lateDed + bonus;
  if (o.final_salary_inr != null && o.final_salary_inr !== "") final = round2(Number(o.final_salary_inr));

  return {
    incentive_inr: incentive,
    leave_deduction_inr: leaveDed,
    late_deduction_inr: lateDed,
    no_leave_bonus_inr: bonus,
    base_salary_snapshot: base,
    gross_inr: base,
    deductions_inr: round2(leaveDed + lateDed),
    net_inr: final,
  };
}

module.exports = {
  defaultPayrollSettings,
  computeIncentive,
  computePayrollRow,
};
