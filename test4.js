const r = await fetch("http://localhost:3000/api/state");
const t = await r.text();
console.log(r.status, t);
