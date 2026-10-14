const seconds = Number(process.argv[2] ?? 60);
console.log(`fixture slow task started for ${seconds}s`);
setTimeout(() => {
  console.log("fixture slow task finished");
}, seconds * 1000);
