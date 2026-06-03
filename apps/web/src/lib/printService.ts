export interface PrintOptions {
  mode?: "window" | "iframe";
  title?: string;
  width?: number;
  height?: number;
  cleanupDelayMs?: number;
}

export class PrintService {
  /**
   * Escape HTML special characters to prevent XSS
   */
  static escapeHtml(text: string): string {
    if (!text) return "";
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/\x27/g, "&#039;");
  }

  /**
   * Print HTML string using iframe or popup window
   */
  static printHtml(htmlContent: string, options: PrintOptions = {}): void {
    const {
      mode = "window",
      width = 500,
      height = 700,
      cleanupDelayMs = 30000,
    } = options;

    if (mode === "iframe") {
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.top = "-9999px";
      iframe.style.width = "0";
      iframe.style.height = "0";
      document.body.appendChild(iframe);

      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc) {
        doc.open();
        doc.write(htmlContent);
        doc.close();
      }

      setTimeout(() => {
        if (document.body.contains(iframe)) {
          document.body.removeChild(iframe);
        }
      }, cleanupDelayMs);
    } else {
      const printWindow = window.open("", "_blank", `width=${width},height=${height}`);
      if (!printWindow) {
        console.error("Failed to open print window. Popup blocker enabled?");
        return;
      }

      printWindow.document.open();
      printWindow.document.write(htmlContent);
      printWindow.document.close();

      setTimeout(() => {
        printWindow.focus();
        printWindow.print();
      }, 300);
    }
  }
}
