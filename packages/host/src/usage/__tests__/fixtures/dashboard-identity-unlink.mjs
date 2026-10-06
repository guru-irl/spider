import { unlinkSync } from "node:fs";
const [temporary] = process.argv.slice(2);
process.once("message", () => {
  setTimeout(() => {
    unlinkSync(temporary);
    process.disconnect();
  }, 35);
});
process.send("ready");
