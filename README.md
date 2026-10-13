# Testing Hub

A private test-tracking page. The page itself is public; the data is not. It loads only after
sign-in, and the database answers only the one allow-listed account.

- `index.html`, `app.js`, `style.css`: the page
- `config.js`: the database address and its publishable (client) key
- `vendor/`: supabase-js 2.45.4 and SheetJS 0.18.5, kept here so the page needs no CDN
