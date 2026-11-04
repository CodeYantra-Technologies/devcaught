import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";

const loopback = "127.0.0.1";
const port = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid port`);
  return value;
};
const smtpPort = port("DEVCAUGHT_SMTP_PORT", 1025);
const origin = `http://${loopback}:${port("DEVCAUGHT_VITE_PORT", 8080)}`;
const api = `${origin}/__devcaught/local-inbox`;
const marker = `p107b-${Date.now()}-${randomBytes(4).toString("hex")}`;

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

function smtpChannel(socket) {
  let buffer = "";
  let lines = [];
  let failure;
  const responses = [];
  const waiters = [];
  const fail = error => {
    failure = error;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("SMTP connection closed unexpectedly")));
  socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    while (true) {
      const end = buffer.indexOf("\r\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        const response = { code: Number(line.slice(0, 3)), lines };
        lines = [];
        const waiter = waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(response);
        } else responses.push(response);
      }
    }
  });

  return {
    read() {
      if (responses.length) return Promise.resolve(responses.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("SMTP response timed out"));
        }, 5_000);
        waiters.push(waiter);
      });
    },
    write(data) {
      return new Promise((resolve, reject) => socket.write(data, error => error ? reject(error) : resolve()));
    },
  };
}

async function expect(channel, code) {
  const response = await channel.read();
  assert(response.code === code, `SMTP expected ${code}, got ${response.code}: ${response.lines.join(" | ")}`);
}

async function sendEmail() {
  const socket = connect({ host: loopback, port: smtpPort });
  const channel = smtpChannel(socket);
  try {
    let connectTimer;
    try {
      await Promise.race([
        once(socket, "connect"),
        new Promise((_, reject) => {
          connectTimer = setTimeout(() => {
            const error = new Error("SMTP connection timed out");
            socket.destroy(error);
            reject(error);
          }, 5_000);
        }),
      ]);
    } finally {
      clearTimeout(connectTimer);
    }
    await expect(channel, 220);
    await channel.write("EHLO local-integration.example.test\r\n");
    await expect(channel, 250);
    await channel.write("MAIL FROM:<sender@example.test>\r\n");
    await expect(channel, 250);
    await channel.write("RCPT TO:<recipient@example.test>\r\n");
    await expect(channel, 250);
    await channel.write("DATA\r\n");
    await expect(channel, 354);
    await channel.write([
      "From: sender@example.test",
      "To: recipient@example.test",
      `Subject: DevCaught integration ${marker}`,
      `Message-ID: <${marker}@example.test>`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      `Synthetic email ${marker}`,
      ".",
      "",
    ].join("\r\n"));
    await expect(channel, 250);
    await channel.write("QUIT\r\n");
    await expect(channel, 221);
  } finally {
    socket.destroy();
  }
}

async function requestJson(path, { method = "GET", body } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    // The numeric loopback URL supplies the matching Host; POSTs need this Origin.
    headers: { accept: "application/json", origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status}: response was not JSON`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error ?? "request failed"}`);
  return result;
}

async function search(channel) {
  const query = new URLSearchParams({ channel, limit: "50", query: marker });
  return requestJson(`/messages?${query}`);
}

async function check(label, action) {
  try {
    await action();
    console.log(`PASS ${label}`);
    return true;
  } catch (error) {
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : "unknown error"}`);
    return false;
  }
}

async function main() {
  try {
    const health = await requestJson("/health");
    assert(health.ok === true && health.mode === "local-capture", "local capture is not ready");
  } catch (error) {
    console.error(`FAIL preflight: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
    return;
  }

  let emailId;
  let smsId;
  let webhookId;
  const results = [];
  results.push(await check("SMTP email + Email API detail", async () => {
    await sendEmail();
    const page = await search("email");
    const item = page.items.find(message => message.subject === `DevCaught integration ${marker}`);
    assert(item, "email not found");
    emailId = item.id;
    const detail = await requestJson(`/messages/${encodeURIComponent(emailId)}`);
    assert(detail.message.textBody.includes(marker), "email detail did not match");
  }));

  results.push(await check("SMS POST + SMS API detail", async () => {
    const response = await requestJson("/sms", {
      method: "POST",
      body: { sender: "+12025550123", recipient: "+12025550199", text: `Synthetic SMS ${marker}` },
    });
    assert(response.ok === true && typeof response.id === "string", "SMS ingress did not return an id");
    smsId = response.id;
    const page = await search("sms");
    const item = page.items.find(message => message.id === smsId);
    assert(item?.sender === "+*******0123" && item.recipient === "+*******0199", "SMS list masking failed");
    const detail = await requestJson(`/messages/${encodeURIComponent(smsId)}`);
    assert(detail.message.body.includes(marker), "SMS detail did not match");
    assert(detail.message.sender === "+*******0123" && detail.message.recipient === "+*******0199", "SMS detail masking failed");
  }));

  results.push(await check("Webhook POST + Webhooks API detail", async () => {
    const response = await requestJson("/webhooks", {
      method: "POST",
      body: { event: `devcaught.integration.${marker}`, testId: marker, note: "synthetic webhook" },
    });
    assert(response.ok === true && typeof response.id === "string", "webhook ingress did not return an id");
    webhookId = response.id;
    const page = await search("webhook");
    assert(page.items.some(message => message.id === webhookId), "webhook not found");
    const detail = await requestJson(`/messages/${encodeURIComponent(webhookId)}`);
    assert(detail.message.method === "POST" && detail.message.textBody.includes(marker), "webhook detail did not match");
  }));

  if (results.every(Boolean)) {
    const all = await check("All-channel search (3 unique records)", async () => {
      const page = await search("all");
      const ids = new Set(page.items.map(message => message.id));
      assert([emailId, smsId, webhookId].every(id => ids.has(id)), "All channel missed a record");
    });
    if (!all) process.exitCode = 1;
  } else {
    process.exitCode = 1;
  }

  console.log(`Synthetic marker: ${marker}`);
}

await main();
