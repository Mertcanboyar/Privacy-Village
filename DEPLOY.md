# Deploying Privacy Village

Click-by-click, no terminal required. Two services: the game server on
Render, the client (game + `/dashboard`) on Vercel. Do these in order —
each step needs a value produced by the one before it.

Total time: about 10 minutes, plus DNS propagation if you add the
custom domain in step D.

---

## A. Deploy the server on Render

1. Go to **[dashboard.render.com](https://dashboard.render.com)** and sign in (or create an account — the free plan is enough).
2. Click **New** (top right) → **Blueprint**.
3. Connect your GitHub account if you haven't already, then select the
   **`privacy-village`** repository.
4. Render reads `render.yaml` from the repo root automatically and shows
   you one service to create:
   ```
   privacy-village-server
   ```
5. It will ask you to fill in the `ALLOWED_ORIGINS` environment variable
   during setup. Leave it as the default for now — you'll come back and
   set the real value in step C, once you know your Vercel URL. If
   Render won't let you leave it blank, temporarily enter:
   ```
   http://localhost:5173
   ```
6. Click **Apply** (or **Create New Resources**) to deploy.
7. Wait for the build to finish — you'll see a **Live** badge with a
   green dot once it's up. This takes 2-3 minutes on the first deploy.
8. Click into the **privacy-village-server** service. Near the top of
   its page, under the service name, you'll see its public URL, shaped
   like:
   ```
   https://privacy-village-server.onrender.com
   ```
   **Copy this URL — you need it in step B.**

   Note: Render's free plan spins the service down after inactivity and
   takes ~30-60 seconds to wake back up on the next connection. That's
   fine here — multiplayer is designed to fail silently and the game
   plays solo while it wakes up.

---

## B. Deploy the client on Vercel

1. Go to **[vercel.com/new](https://vercel.com/new)** and sign in (or
   create an account).
2. Click **Add New...** → **Project**.
3. Under **Import Git Repository**, find and import **`privacy-village`**
   (connect your GitHub account first if prompted).
4. On the configure screen, find **Root Directory** and click **Edit**.
   Set it to:
   ```
   client
   ```
   Vercel should auto-detect the framework as **Vite** once you do this
   — leave the build/output settings on their defaults.
5. Expand **Environment Variables**. Add one:
   - Name:
     ```
     VITE_WS_URL
     ```
   - Value — take the Render URL from step A.8, change `https://` to
     `wss://`, and use that. For example, if your Render URL was
     `https://privacy-village-server.onrender.com`, the value is:
     ```
     wss://privacy-village-server.onrender.com
     ```
6. Click **Deploy**. This takes about a minute.
7. Once it's done, Vercel shows you the live URL, shaped like:
   ```
   https://privacy-village.vercel.app
   ```
   **Copy this exact URL — you need it in step C.**

---

## C. Connect them: set ALLOWED_ORIGINS on Render

The server currently only accepts requests from `http://localhost:5173`
(or whatever placeholder you entered in step A.5) — your live Vercel
site can't talk to it yet until you allow its origin explicitly.

1. Go back to **[dashboard.render.com](https://dashboard.render.com)**
   and open the **privacy-village-server** service.
2. Click the **Environment** tab in the left sidebar.
3. Find (or add) the **`ALLOWED_ORIGINS`** variable and set its value to
   your exact Vercel URL from step B.7, with no trailing slash:
   ```
   https://privacy-village.vercel.app
   ```
4. Click **Save Changes**. Render will automatically redeploy the
   service with the new value (takes under a minute — you'll see a new
   deploy appear in the **Events** tab).

At this point the game is live end-to-end. Skip to the **Verification
checklist** below, or continue to step D if you want the custom domain
now.

---

## D. Optional: add the custom domain (demo.privacyvillage.com)

1. In Vercel, open your **privacy-village** project → **Settings** →
   **Domains**.
2. Type in the domain:
   ```
   demo.privacyvillage.com
   ```
   and click **Add**.
3. Vercel will show you a DNS record to create with whoever manages DNS
   for `privacyvillage.com` (your domain registrar or DNS host — e.g.
   Namecheap, GoDaddy, Cloudflare). It will be a **CNAME** record shaped
   like this:
   ```
   Type:  CNAME
   Name:  demo
   Value: cname.vercel-dns.com
   ```
   Use the exact value Vercel shows you on that page — it can differ
   slightly by account, so copy it from there rather than retyping the
   above.
4. Add that CNAME record in your DNS provider's dashboard, then return
   to Vercel's Domains page — it will show a checkmark once the record
   is detected (can take a few minutes up to a few hours depending on
   your DNS provider).
5. Once it's live, go back to **Render → privacy-village-server →
   Environment → ALLOWED_ORIGINS** and add the new domain to the list,
   comma-separated, alongside your existing Vercel URL:
   ```
   https://privacy-village.vercel.app,https://demo.privacyvillage.com
   ```
6. Click **Save Changes** and let it redeploy.

---

## Verification checklist

Run through these on the live URL (Vercel URL, or your custom domain if
you set one up) once everything above is deployed:

- [ ] **Two devices see each other.** Open the site on two different
      devices (or two browsers/incognito windows), create two
      characters, and walk them into the village. Each should see the
      other's avatar moving, named, and faction-colored.
- [ ] **One full quest works end-to-end.** Play through "The Breach in
      the Wall" (or any quest) from start to finish on the production
      site — dialogue, choices, and quest completion should all work
      exactly as they did locally.
- [ ] **`/dashboard` CSV download.** Visit `https://<your-domain>/dashboard`,
      click **Export Grades (CSV)**, and confirm a file downloads and
      opens cleanly with all 24 rows.
- [ ] **Solo fallback still works.** In the Render dashboard, manually
      suspend or stop the **privacy-village-server** service (Settings →
      **Suspend Service**), then reload the live game site. It should
      load and play completely normally with no errors — multiplayer is
      designed to fail silently. Resume the service afterward
      (Settings → **Resume Service**) to bring multiplayer back.
