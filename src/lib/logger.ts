type SafeLog = Record<string, string | number | boolean | null | undefined>;

function scrub(fields: SafeLog): SafeLog {
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => !/key|token|audio|base64|image/i.test(key)),
  );
}

export const logger = {
  info(event: string, fields: SafeLog = {}) {
    console.info(JSON.stringify({ level: "info", event, ...scrub(fields) }));
  },
  error(event: string, fields: SafeLog = {}) {
    console.error(JSON.stringify({ level: "error", event, ...scrub(fields) }));
  },
};
