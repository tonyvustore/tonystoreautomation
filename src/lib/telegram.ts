export interface TelegramOptions {
  enabled: boolean;
  botToken: string;
  chatId: string;
  dryRun: boolean;
}

export class TelegramReporter {
  constructor(private readonly options: TelegramOptions) {}

  private escapeHtml(input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private pickIcon(step: string): string {
    const s = step.toLowerCase();
    if (s.includes('bắt đầu') || s.includes('start')) return '🚀';
    if (s.includes('hoàn thành') || s.includes('complete') || s.includes('processed')) return '✅';
    if (s.includes('lỗi') || s.includes('error') || s.includes('failed')) return '❌';
    if (s.includes('cập nhật') || s.includes('update') || s.includes('updated')) return '🛠️';
    if (s.includes('chuyển') || s.includes('transition')) return '🔄';
    return this.options.dryRun ? '🧪' : '🤖';
  }

  private async postMessage(text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<void> {
    if (!this.options.enabled) {
      return;
    }

    const url = `https://api.telegram.org/bot${this.options.botToken}/sendMessage`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.options.chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
        }),
      });

      if (!response.ok) {
        console.error('Failed to deliver Telegram message', await response.text());
      }
    } catch (error) {
      console.error('Telegram request error', error);
    }
  }

  async notify(step: string, details?: string): Promise<void> {
    const dryRunLabel = this.options.dryRun ? '🧪 Chế độ thử' : '🤖 Tự động';
    const icon = this.pickIcon(step);
    const header = `${icon} ${step}`;
    const lines: string[] = [];

    lines.push(`<b>${this.escapeHtml(dryRunLabel)}:</b> <b>${this.escapeHtml(header)}</b>`);
    if (details) {
      lines.push(`<pre>${this.escapeHtml(details)}</pre>`);
    }
    const message = lines.join('\n');

    console.log(`[automation] ${dryRunLabel}: ${step} ${details ? details.replace(/\*/g, '') : ''}`);
    await this.postMessage(message, 'HTML');
  }
}
