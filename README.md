# Pancafe Live

Live dashboard for the cafe's PanCafe Pro server: PCs in use, income by hour and day, staff totals, products and member balances.

- `index.html` is the whole dashboard. `config.js` holds the Supabase URL and the public anon key; all data is behind sign-in and an email allow-list (`pancafe_viewers`).
- Data arrives from the PanCafe Bridge agent on the server PC, which reads a copy of PanCafe's database every 10 seconds.

## PC health

The **PC health** page (`pchealth.js`) shows each customer PC's temperatures, load, drives and Windows errors, and explains every unexpected shutdown or blue screen in plain words. Data comes from the PanCafe PC Health agent (a PowerShell script installed on each customer PC) through `pchealth_ingest()`; set up the tables once with `supabase/pchealth.sql`.

## Apps

- **Install from the browser:** open the dashboard in Chrome or Edge (Android or PC) and choose **Install app** in the menu, or the Install app button in the dashboard.
- **Android app:** https://github.com/MaxAz1986/pancafe-live/releases/download/apps/PancafeLive.apk
- **Windows app:** https://github.com/MaxAz1986/pancafe-live/releases/download/apps/PancafeLive-Setup.exe

Both apps open the live dashboard website, so design changes reach them without reinstalling. They are built by `.github/workflows/apps.yml` from `apps/android` and `apps/windows` whenever those folders change.
