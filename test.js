const r = await fetch("http://localhost:3000/api/proxy/api/state?workerUrl=https://google.com");
if (r.ok) console.log(r.status, "ok");
else console.log(r.status, await r.text());
