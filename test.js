const r = await fetch("https://tradeengine.tjluckydominos.workers.dev/api/state");
const t = await r.text();
console.log(r.status, t.slice(0, 100));
