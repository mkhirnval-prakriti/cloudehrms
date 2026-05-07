# Complete Deployment Guide — HRMS Portal

## Step 1: Database Setup (Neon PostgreSQL — Free)

### Create Neon Database
1. Go to https://neon.tech → Sign up (free)
2. Click "New Project"
3. Name: `hrms-portal`
4. Region: Choose closest to your users (Asia Pacific for India)
5. Click "Create Project"
6. Copy the **Connection String** (starts with `postgresql://`)
7. Save it — you'll need it in the next steps

Your connection string looks like:
```
postgresql://username:password@ep-xxx-xxx.ap-southeast-1.aws.neon.tech/hrmsdb?sslmode=require
```

---

## Step 2: GitHub Repository

### Push Code to GitHub
```bash
cd hrms-portal-clone

# Initialize git
git init
git add .
git commit -m "HRMS Portal v2.0 — PostgreSQL + Free tier deployment"
git branch -M main

# Create repo at github.com/new → name: hrms-portal-clone
git remote add origin https://github.com/YOUR_USERNAME/hrms-portal-clone.git
git push -u origin main
```

---

## Step 3: Backend Deployment (Render Free)

1. Go to https://render.com → Sign up
2. Dashboard → **New +** → **Web Service**
3. Connect GitHub → Select `hrms-portal-clone`
4. Configure:
   - **Name:** `hrms-portal-api`
   - **Region:** Oregon (US) or Singapore
   - **Branch:** main
   - **Build Command:** `bash build.sh`
   - **Start Command:** `bash start.sh`
   - **Plan:** Free

5. **Environment Variables** (click "Add Environment Variable"):
   ```
   NODE_ENV=production
   DATABASE_URL=[paste your Neon connection string]
   DB_SSL=1
   SESSION_SECRET=[generate: openssl rand -hex 32]
   JWT_SECRET=[generate: openssl rand -hex 48]
   SUPER_ADMIN_EMAIL=your-admin@email.com
   PORT=5000
   ```

6. Click **Create Web Service**
7. Wait for deployment (3-5 minutes)
8. Note your Render URL: `https://hrms-portal-api-xxxx.onrender.com`

### First Login
- Open: `https://hrms-portal-api-xxxx.onrender.com`
- Check Render logs for auto-generated password
- Login ID: `prakritiherbs`
- Or set `SUPER_ADMIN_PASSWORD=YourPassword123` env var before first deploy

---

## Step 4: Frontend Deployment (Vercel Free)

1. Go to https://vercel.com → Sign up
2. Dashboard → **Add New** → **Project**
3. Import from GitHub → Select `hrms-portal-clone`
4. Configure:
   - **Framework Preset:** Vite
   - **Root Directory:** `client`
   - **Build Command:** `npm run build`
   - **Output Directory:** `../dist`
5. **Environment Variables:**
   ```
   VITE_API_URL=[your Render URL, e.g. https://hrms-portal-api-xxxx.onrender.com]
   ```
6. Click **Deploy**
7. Note your Vercel URL: `https://hrms-portal-xxxx.vercel.app`

### Update Backend CORS
Go to Render → Environment → Add:
```
ALLOWED_ORIGINS=https://hrms-portal-xxxx.vercel.app
```

---

## Step 5: Google Sheets Sync (Optional)

1. Open https://script.google.com
2. New Project → paste code from `google-apps-script/hrms_sync.gs`
3. **Deploy** → **New Deployment** → **Web App**
   - Execute as: Me
   - Who has access: Anyone
4. Copy the Web App URL
5. Add to Render env vars:
   ```
   GOOGLE_APPS_SCRIPT_WEBAPP_URL=https://script.google.com/macros/s/xxx/exec
   SHEET_SYNC_SECRET=your-random-secret-here
   ```
6. Also add `SHEET_SYNC_SECRET` to your Apps Script properties:
   - Apps Script → Project Settings → Script Properties → Add `SHEET_SYNC_SECRET`

---

## Step 6: Prevent Render Sleep (UptimeRobot — Free)

1. Go to https://uptimerobot.com → Sign up (free)
2. **Add New Monitor**:
   - Monitor Type: HTTP(s)
   - Friendly Name: HRMS Portal
   - URL: `https://hrms-portal-api-xxxx.onrender.com/health`
   - Monitoring Interval: Every 5 minutes
3. Click **Create Monitor**

This keeps your Render service awake 24/7 for free.

---

## Step 7: Custom Domain (Hostinger)

### Connect to Vercel (Frontend)
1. Vercel → your project → **Settings** → **Domains**
2. Add your domain: `hrms.yourcompany.com`
3. Vercel shows you DNS records to add

4. Go to **Hostinger** → Domain → DNS / Nameservers → DNS Zone
5. Add records:
   ```
   Type: CNAME
   Name: hrms (or www, or @)
   Target: cname.vercel-dns.com
   TTL: 3600
   ```

### Connect to Render (Backend API)
1. Render → your service → **Settings** → **Custom Domains**
2. Add: `api.yourcompany.com`
3. Render shows you a CNAME to add

4. Hostinger → DNS Zone → Add:
   ```
   Type: CNAME
   Name: api
   Target: [your-service].onrender.com
   TTL: 3600
   ```

### SSL
Both Vercel and Render auto-provision SSL certificates (Let's Encrypt).
After DNS propagates (10-30 min), HTTPS will work automatically.

---

## Step 8: Email Setup (Gmail SMTP)

1. Enable 2FA on Gmail: https://myaccount.google.com/security
2. App Passwords: https://myaccount.google.com/apppasswords
3. Generate password for "Mail" app
4. Add to Render env vars:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your@gmail.com
   SMTP_PASS=xxxx xxxx xxxx xxxx (16-char app password, no spaces)
   SMTP_FROM=HRMS Portal <your@gmail.com>
   ALERT_EMAIL_TO=admin@yourcompany.com
   ```

---

## Alternative: Railway Deployment (Backend + DB together)

If you prefer Railway over Render+Neon:

1. Go to https://railway.app → New Project
2. Deploy from GitHub → Select repo
3. Add **PostgreSQL** service from Railway's service catalog
4. Railway auto-sets `DATABASE_URL`
5. Add remaining env vars in Variables tab
6. Deploy

Railway Free: $5 credit/month (enough for ~500 hours)

---

## Alternative: Koyeb (No sleep issue — truly free)

1. Go to https://www.koyeb.com → Sign up
2. New App → GitHub → Select repo
3. Build: `bash build.sh`
4. Start: `bash start.sh`
5. Add env vars
6. Deploy

Koyeb Free: 1 instance, always-on (no sleep)

---

## Health Check

After deployment, verify:
```
GET https://your-backend.onrender.com/health
Response: {"ok":true,"service":"hrms-portal","status":"ok"}
```

## Troubleshooting

**"DATABASE_URL not set" error:**
→ Add DATABASE_URL env var in Render dashboard

**"App not built" on first visit:**  
→ Build must complete first. Check build logs.

**CORS error:**
→ Add your Vercel URL to ALLOWED_ORIGINS env var

**Render sleeping:**
→ Set up UptimeRobot (Step 6)

**Login not working:**
→ Check Render logs for auto-generated password on first boot
