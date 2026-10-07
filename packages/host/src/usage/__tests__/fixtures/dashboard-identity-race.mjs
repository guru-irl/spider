const [bundle, file] = process.argv.slice(2);
const { initializeIds } = await import(bundle);
const functions = {};
const ctx = { db: { raw: { name: file, function(name, _options, fn) { functions[name] = fn; } } } };
process.once("message", () => {
  try {
    initializeIds(ctx);
    console.log(functions.explorer_id("project", "synthetic-project"));
  } catch (error) { console.log("ERR " + (error.code ?? error.message)); }
  finally { process.disconnect(); }
});
process.send("ready");
