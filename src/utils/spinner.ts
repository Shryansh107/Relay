export class Spinner {
  private intervalId: NodeJS.Timeout | null = null;
  private currentFrame = 0;
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private text = "";
  private readonly isTTY: boolean;

  constructor() {
    this.isTTY = process.stdout.isTTY && !process.env.CI;
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
    // Clear line and write
    process.stdout.write("\x1b[2K" + output);
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

    const symbol = success ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
    process.stdout.write(`\x1b[2K\r${symbol} ${finalStatusText}\n`);
  }
}
