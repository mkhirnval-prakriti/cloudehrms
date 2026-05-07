# HRMS Portal

A production-ready Human Resource Management System for attendance, payroll, leaves, and employee management.

**Stack:** Node.js + Express + React + TypeScript + PostgreSQL (Neon/Supabase)

## Features

- ✅ Attendance with GPS, Face Recognition, WebAuthn (Passkeys), QR Code, Kiosk
- ✅ Leave Management with multi-level approval
- ✅ Payroll Engine with dynamic salary calculation
- ✅ Employee Management with RBAC (Super Admin, Admin, Location Manager, Staff)
- ✅ Google Sheets real-time sync
- ✅ Daily email reports
- ✅ WhatsApp notifications (optional)
- ✅ Document upload & verification
- ✅ Push notifications (PWA)
- ✅ Mobile app (Expo React Native)
- ✅ CRM leads module

## Free Deployment Stack

| Service | Platform | Cost |
|---------|----------|------|
| Frontend | Vercel Free | $0 |
| Backend | Render Free | $0 |
| Database | Neon PostgreSQL | $0 |
| Email | Gmail SMTP | $0 |
| Files | Local / Cloudflare R2 | $0 |
| SSL | Auto (Vercel/Render) | $0 |

## Quick Start (Local Development)

```bash
# 1. Clone
git clone https://github.com/YOUR_USER/hrms-portal-clone.git
cd hrms-portal-clone

# 2. Setup env
cp .env.example .env
# Edit .env — set DATABASE_URL to your Neon/Supabase connection string

# 3. Install
npm install

# 4. Build frontend
npm run build

# 5. Start server
npm start
# Visit http://localhost:5000
```

## Database Setup (Neon — Free)

1. Go to [neon.tech](https://neon.tech) → Create free account
2. Create project → Copy connection string
3. Paste into `.env` as `DATABASE_URL`
4. Tables are auto-created on first startup

## Deployment

### Option A: Render (Backend) + Vercel (Frontend)

**Backend on Render:**
1. Push to GitHub
2. Render → New Web Service → Connect repo
3. Build: `bash build.sh` | Start: `bash start.sh`
4. Add env vars from `.env.example`
5. Set `DATABASE_URL` to Neon connection string

**Frontend on Vercel:**
1. Vercel → New Project → Connect same repo
2. Framework: Vite | Root: `client/`
3. Build: `npm run build` | Output: `../dist`
4. Add `VITE_BACKEND_URL` = your Render URL

### Option B: Railway (Backend + Database together)

1. Railway → New Project → Deploy from GitHub
2. Add Railway PostgreSQL service
3. `DATABASE_URL` auto-injected
4. Add remaining env vars

### Option C: Koyeb (No sleep issue)

1. [koyeb.com](https://koyeb.com) → New App → GitHub
2. Build: `bash build.sh` | Start: `bash start.sh`
3. Add env vars

## Avoid Render Free Sleep

Use [UptimeRobot](https://uptimerobot.com) (free):
- Monitor URL: `https://your-backend.onrender.com/health`
- Interval: 5 minutes
- This prevents the 15-min sleep on Render Free

## First Login

After deployment, the super admin account is created automatically:
- Login ID: `prakritiherbs`
- Password: Check server logs on first boot (or set `SUPER_ADMIN_PASSWORD` env var)

## Google Sheets Sync

1. Open `google-apps-script/hrms_sync.gs`
2. Create new Google Apps Script project
3. Paste the code, deploy as Web App
4. Copy the Web App URL to `GOOGLE_APPS_SCRIPT_WEBAPP_URL`
5. Set `SHEET_SYNC_SECRET` (same secret in both .env and Apps Script)

## Custom Domain (Hostinger)

After deployment:

**For Vercel Frontend:**
```
DNS Type: CNAME
Name: @  (or www)
Value: cname.vercel-dns.com
```

**For Render Backend:**
```
DNS Type: CNAME  
Name: api
Value: your-service.onrender.com
```

Then in Vercel/Render dashboard → Add custom domain.

## Environment Variables

See `.env.example` for complete list with documentation.

## Security Notes

- Never commit `.env` to GitHub
- Rotate `SESSION_SECRET` and `JWT_SECRET` regularly
- Delete `SUPER_ADMIN_PASSWORD` after first login
- Enable `CORS_STRICT=1` in production
- Use Gmail App Password (not regular password)

## License

ISC
