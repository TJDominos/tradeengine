const fetchState = async () => {
  const r = await fetch("https://ais-dev-ylcktp6jnqyocaed5zuoxq-343731842688.europe-west2.run.app/api/state");
  const t = await r.text();
  console.log(r.status, t);
};
fetchState();
