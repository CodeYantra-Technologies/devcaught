#!/usr/bin/env node
import nodemailer from "nodemailer";

const host = process.env.DEVCAUGHT_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.DEVCAUGHT_SMTP_PORT || 1025);
const fixture = process.argv.includes("--fixture=link") ? "link" : "otp";

const messages = {
  otp: {
    from: "NexaField <noreply@example.test>",
    to: "developer@example.test",
    subject: "Verify your account",
    text: "Your verification code is 482913.\nThis code expires in 10 minutes.",
  },
  link: {
    from: "NexaField <noreply@example.test>",
    to: "developer@example.test",
    subject: "Reset your password",
    text: "Reset your password at https://nexa.test/reset/abc123\nThis link expires in 30 minutes.",
    html: `<p>Reset your password at <a href="https://nexa.test/reset/abc123">https://nexa.test/reset/abc123</a></p>`,
  },
};

const transport = nodemailer.createTransport({
  host,
  port,
  secure: false,
  tls: { rejectUnauthorized: false },
});

try {
  const info = await transport.sendMail(messages[fixture]);
  console.log(`Sent ${fixture} fixture to ${host}:${port} as ${info.messageId}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Could not send mail to ${host}:${port}. Is DevCaught running?\n${message}`);
  process.exit(1);
}
