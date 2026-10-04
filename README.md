# Pancafe Live

Live dashboard for the cafe's PanCafe Pro server: PCs in use, income by hour and day, staff totals, products and member balances.

- `index.html` is the whole dashboard. `config.js` holds the Supabase URL and the public anon key; all data is behind sign-in and an email allow-list (`pancafe_viewers`).
- Data arrives from the PanCafe Bridge agent on the server PC, which reads a copy of PanCafe's database every 10 seconds.
