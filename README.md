# UNO — Doston Ke Saath (Real Multiplayer)

Apna khud ka UNO app — dost apne-apne phone se, room code daal kar, ek hi live game me khelte hain.
Sab kuch server se chalta hai: cards, baari, rang, UNO penalty — server hi boss hai, koi fake join nahi.

## Kaise khelo

1. **Room Banao** — apna naam likho, "Room Banao" dabao. Tujhe 5-letter code milega (jaise `K7XQ2`).
2. **Code bhejo** — code doston ko WhatsApp / kahi bhi bhej de.
3. **Dost Join karenge** — wo link khol kar apna naam + code daalenge. 2–5 players tak jud sakte hain.
4. **Start dabao** — host (room banane wala) Start dabayega, tabhi cards batenge.
5. **Khelo** — apni baari pe apna card dabao. Rang/number milna chahiye, ya Wild khelo.
   - **UNO!** — jab tere paas 2 cards hon aur ek khelne wala ho, pehle **UNO!** button dabao. Bhool gaye toh **+2 penalty cards**.
   - Card na chale toh **draw pile** dabao — khecha hua card chale toh khel sakte ho, warna Pass.
6. **Jeeto** — jiske cards pehle khatam, wo round jeetta. **Dobara Khelo** se naya round, same players.

## Rules (server-authoritative)

- 108-card deck, har game me naya shuffle.
- 7 cards har player ko. Skip, Reverse, +2, Wild, Wild +4 sab chalte hain.
- Draw pile khatam ho toh discard pile shuffle ho kar naya draw pile banta hai.
- Agar refresh ho jaye toh player apni seat pe wapas jud jata hai (token sessionStorage me rehta hai) aur uska haath wapas mil jata hai.
- Koi account / password nahi chahiye.

## Local me chalao

```bash
npm install
node server.js
```

Phir browser me kholo: http://localhost:3000

## Render (free) pe live karo — exact steps

1. Is folder ka code **GitHub repo** me push karo (repo ka naam kuch bhi, jaise `uno-friends`).
2. https://render.com pe jao → **New → Web Service** → apna GitHub repo select karo.
3. Settings me ye daalo:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
4. **Create Web Service** dabao. Deploy hone me 1–2 minute lagenge.
5. Deploy hone ke baad Render tujhe ek live URL dega (jaise `https://uno-friends-xxxx.onrender.com`) — wahi URL doston ko bhej de, sab usi se khelenge.

**Note:**
- Free Render instance idle rehne pe so jata hai — pehli baar kholne me ~1 minute lag sakta hai. Uske baad sab smooth chalega.
- Rooms server ki memory me hain — server restart hoga toh purane rooms mit jayenge, naya room banana padega. Chal rahe game me refresh karne pe seat bach jati hai.

## Files

- `server.js` — HTTP + WebSocket server, saara game logic (single source of truth).
- `public/index.html` — app ka page.
- `public/style.css` — styling + card animations.
- `public/client.js` — browser client (WebSocket, screens, hand rendering).
- `test/smoke.js` — automated smoke test (3 scripted players, real moves, state-consistency check).
