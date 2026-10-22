# Deploying to Vercel

Vercel runs the API as one serverless function (Express is supported with zero configuration) and serves `public/` (the Shelfline web app) from its CDN. Vercel does not run PostgreSQL itself, so you need a hosted database; **Neon** is the usual choice and is available from the Vercel Marketplace.

## 1. Create the database (Neon)

1. Create a Neon project (neon.tech, or Vercel dashboard → Storage → Neon).
2. From the Neon dashboard copy **two** connection strings:
   - **Direct** (no `-pooler` in the host), used once for setup.
   - **Pooled** (host contains `-pooler`), used by the live app.
   Both end with `?sslmode=require`.

## 2. One-time setup from your computer

This creates the tables and **your** manager account before the site is public, so nobody else can claim the first (manager) account.

PowerShell, in the project folder:

```powershell
$env:DATABASE_URL="<direct connection string>"
$env:ADMIN_NAME="Your Name"
$env:ADMIN_EMAIL="you@company.com"
$env:ADMIN_PASSWORD="a-strong-password-with-a-number1"
npm install
npm run bootstrap
```

It prints `Bootstrap complete`. Re-running is safe. Do **not** run `npm run seed` against the live database (it adds sample products; in production mode it does not create demo accounts).

## 3. Put the code on GitHub

```powershell
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/inventory-api.git
git push -u origin main
```

## 4. Create the Vercel project

1. vercel.com → **Add New… → Project** → import the GitHub repo.
2. Framework preset: **Express** (auto-detected). Leave build settings as they are.
3. Add **Environment Variables**:

| Name | Value |
|---|---|
| `DATABASE_URL` | the **pooled** connection string |
| `DB_POOL_MAX` | `3` (each serverless instance keeps few connections) |
| `SIGNUP_CODE` | a secret code you give to staff, so strangers cannot create accounts |
| `LOG_LEVEL` | `info` |

4. Click **Deploy**. Open the URL Vercel gives you and sign in with the account from step 2.

CLI alternative: `npm i -g vercel`, then `vercel` (preview) and `vercel --prod`.

## Things to know on Vercel

- **Stock safety is unchanged.** Overselling protection lives in the database transaction, so it holds across any number of serverless instances.
- **Rate limiting is per instance.** The built-in limiter keeps counters in memory, and serverless instances come and go, so it is only a soft limit here. For a hard limit use Vercel's Firewall rate limiting (or a shared store such as Redis).
- **Migrations are not run on Vercel.** Run `npm run bootstrap` (direct connection string) whenever you add a new file in `migrations/`.
- **Use the pooled string in Vercel and the direct string for `bootstrap`.** Migrations use a session-level advisory lock, which a pooler can break.
- **Swagger UI (`/api-docs`)** may not render on Vercel because its asset files are not always bundled into the function. The raw spec at `/api-docs.json` and `docs/openapi.json` always work.
- **Cold starts:** the first request after idle time can take a second or two.
- **HTTPS** is automatic, so the session cookie is marked secure.

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| Page loads but sign-in fails with a 500 | `DATABASE_URL` missing/wrong in Vercel, or `bootstrap` was never run. See Vercel → Deployment → Logs. |
| `too many connections` / timeouts | You used the direct string in Vercel, or `DB_POOL_MAX` is high. Use the pooled string and `DB_POOL_MAX=3`. |
| "A valid invite code is required" | `SIGNUP_CODE` is set (good). Enter that code on the Create account form. |
| Build says no entrypoint found | Make sure the Framework preset is Express and the repo root contains `package.json`. |
