import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const APP_SESSION_COOKIE = "creatoros_dashboard";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const DEFAULT_ADMIN_EMAIL = "oscreter@gmail.com";

type AppAuthConfig = { email: string; password: string; hospitalId: string; sessionSecret: string };

function config(): AppAuthConfig {
  const password = process.env.APP_ADMIN_PASSWORD;
  const hospitalId = process.env.APP_HOSPITAL_ID;
  const sessionSecret = process.env.APP_SESSION_SECRET;
  if (!password || !hospitalId || !sessionSecret) {
    throw new Error("Dashboard login is not configured. Set APP_ADMIN_PASSWORD, APP_HOSPITAL_ID, and APP_SESSION_SECRET.");
  }
  return { email: (process.env.APP_ADMIN_EMAIL ?? DEFAULT_ADMIN_EMAIL).trim().toLowerCase(), password, hospitalId, sessionSecret };
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signature(email: string, issuedAt: number, secret: string) {
  return createHmac("sha256", secret).update(`${email}:${issuedAt}`).digest("base64url");
}

export function validateAdminLogin(email: string, password: string) {
  const app = config();
  return safeEqual(email.trim().toLowerCase(), app.email) && safeEqual(password, app.password);
}

export function createDashboardSession() {
  const app = config();
  const issuedAt = Date.now();
  return `${app.email}.${issuedAt}.${signature(app.email, issuedAt, app.sessionSecret)}`;
}

export async function hasDashboardSession() {
  try {
    const token = (await cookies()).get(APP_SESSION_COOKIE)?.value;
    if (!token) return false;
    const [email, timestamp, receivedSignature] = token.split(".");
    const issuedAt = Number(timestamp);
    const app = config();
    return Boolean(email && receivedSignature && Number.isFinite(issuedAt) && Date.now() - issuedAt < SESSION_MAX_AGE && safeEqual(email, app.email) && safeEqual(receivedSignature, signature(email, issuedAt, app.sessionSecret)));
  } catch { return false; }
}

export async function requireDashboardHospital() {
  if (!await hasDashboardSession()) throw new Error("Unauthorized");
  return config().hospitalId;
}

export const dashboardSessionCookie = () => ({ httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: SESSION_MAX_AGE });
