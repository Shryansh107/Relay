export class Spinner {
  private intervalId: NodeJS.Timeout | null = null;
  private currentFrame = 0;
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private text = "";
  private readonly isTTY: boolean;
  private logs: string[] = [];
  private readonly logLimit = 4;

  constructor() {
    this.isTTY = process.stdout.isTTY && !process.env.CI;
  }

  get isActive(): boolean {
    return this.intervalId !== null;
  }

  log(msg: string) {
    if (!this.isTTY || !this.intervalId) {
      return;
    }
    const cols = process.stdout.columns || 80;
    const maxLen = Math.max(10, cols - 8);
    const cleanMsg = msg.replace(/\r?\n/g, " ").trim();
    if (!cleanMsg) return;
    const truncated = cleanMsg.length > maxLen ? cleanMsg.substring(0, maxLen - 3) + "..." : cleanMsg;
    this.logs.push(truncated);
    if (this.logs.length > this.logLimit) {
      this.logs.shift();
    }
    this.render();
  }

  start(text: string) {
    this.text = text;
    if (!this.isTTY) {
      return;
    }

    // Hide cursor
    process.stdout.write("\x1b[?25l");
    this.render();

    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      this.render();
    }, 80);
  }

  update(text: string) {
    this.text = text;
    if (!this.isTTY) {
      return;
    }
    this.render();
  }

  private render() {
    const frame = this.frames[this.currentFrame];
    // Cyan spinner, bold text
    const output = `\r\x1b[36m${frame}\x1b[0m \x1b[1m${this.text}\x1b[0m`;
    let fullOutput = "\x1b[2K" + output;

    for (let i = 0; i < this.logLimit; i++) {
      const logLine = this.logs[i] || "";
      fullOutput += `\n\x1b[2K    \x1b[90m${logLine}\x1b[0m`;
    }
    fullOutput += `\x1b[${this.logLimit}A\r`;

    process.stdout.write(fullOutput);
  }

  stop(success: boolean, finalStatusText: string) {
    if (!this.isTTY) {
      return;
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Show cursor
    process.stdout.write("\x1b[?25h");

    // Clear logs pane below
    for (let i = 0; i < this.logLimit; i++) {
      process.stdout.write("\n\x1b[2K");
    }
    // Move back up to spinner line
    process.stdout.write(`\x1b[${this.logLimit}A\r`);

    const symbol = success ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
    process.stdout.write(`\x1b[2K\r${symbol} ${finalStatusText}\n`);
    this.logs = [];
  }
}
