type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const ANSI = {
  reset: "\u001b[0m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  gray: "\u001b[90m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  DEBUG: ANSI.gray,
  INFO: ANSI.blue,
  WARN: ANSI.yellow,
  ERROR: ANSI.red,
};

function paint(color: string, value: string): string {
  return `${color}${value}${ANSI.reset}`;
}

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function log(level: LogLevel, module: string, message: string, ...args: unknown[]): void {
  const prefix = `${paint(ANSI.dim, timestamp())} ${paint(LEVEL_COLOR[level], `[${level}]`)} ${paint(ANSI.cyan, `[${module}]`)}`;
  console.log(`${prefix} ${message}`, ...args);
}

export function createLogger(module: string) {
  return {
    debug: (msg: string, ...args: unknown[]) => log("DEBUG", module, msg, ...args),
    info: (msg: string, ...args: unknown[]) => log("INFO", module, msg, ...args),
    warn: (msg: string, ...args: unknown[]) => log("WARN", module, msg, ...args),
    error: (msg: string, ...args: unknown[]) => log("ERROR", module, msg, ...args),
  };
}
