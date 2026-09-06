import { exchangeInstapaperAccessToken } from "../integrations/instapaper/instapaperClient.js";
import { loadDotEnv } from "../utils/envFile.js";
import { fail, usage } from "./lib/cli.js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

loadDotEnv();

if (process.argv.includes("--help")) {
  usage("Usage: npm run instapaper:token\nRequires INSTAPAPER_CONSUMER_KEY and INSTAPAPER_CONSUMER_SECRET. Username and password are prompted when not supplied by environment variables.");
}

let username = readArgument("--username") || process.env.INSTAPAPER_USERNAME || "";
const consumerKey = process.env.INSTAPAPER_CONSUMER_KEY || "";
const consumerSecret = process.env.INSTAPAPER_CONSUMER_SECRET || "";
let password = process.env.INSTAPAPER_PASSWORD || "";

if (!consumerKey || !consumerSecret) fail("INSTAPAPER_CONSUMER_KEY / INSTAPAPER_CONSUMER_SECRET are required");
if (!username || !password) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("Interactive input requires a terminal. Set INSTAPAPER_USERNAME and INSTAPAPER_PASSWORD temporarily instead.");
  }
  let muted = false;
  const promptOutput = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    }
  });
  const readline = createInterface({ input: process.stdin, output: promptOutput, terminal: true });
  try {
    if (!username) username = (await readline.question("Instapaper username/email: ")).trim();
    if (!password) {
      process.stdout.write("Instapaper password: ");
      muted = true;
      password = await readline.question("");
      muted = false;
      process.stdout.write("\n");
    }
  } finally {
    muted = false;
    readline.close();
  }
}
if (!username) fail("Instapaper username/email is required");
if (!password) fail("Instapaper password is required");

const token = await exchangeInstapaperAccessToken({ consumerKey, consumerSecret, username, password });
console.log("Instapaper access token created. Add these two lines to .env:");
console.log(`INSTAPAPER_ACCESS_TOKEN=${token.accessToken}`);
console.log(`INSTAPAPER_ACCESS_TOKEN_SECRET=${token.accessTokenSecret}`);

function readArgument(name: string): string {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}
