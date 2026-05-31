const r = await fetch("http://localhost:3000");
const t = await r.text();
console.log(r.status, t.slice(0, 300));
