export interface PrintOptions {
  mode?: "window" | "iframe";
  title?: string;
  width?: number;
  height?: number;
  cleanupDelayMs?: number;
  readyDelayMs?: number;
}

export class PrintService {
  private static printInProgress = false;
  private static safetyTimer: number | null = null;

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
  private static beginPrint(): void {
    if (PrintService.printInProgress) {
      throw new Error("Попереднє вікно друку ще відкрите. Закрийте його перед повторним друком.");
    }
    PrintService.printInProgress = true;
    if (PrintService.safetyTimer !== null) window.clearTimeout(PrintService.safetyTimer);
    PrintService.safetyTimer = window.setTimeout(() => PrintService.endPrint(), 120000);
  }

  private static endPrint(): void {
    PrintService.printInProgress = false;
    if (PrintService.safetyTimer !== null) {
      window.clearTimeout(PrintService.safetyTimer);
      PrintService.safetyTimer = null;
    }
  }

  static printCurrentPage(): boolean {
    // A double click or automatic print followed by a manual click must not
    // create a second OS spooler job while the first dialog is still open.
    if (PrintService.printInProgress) return false;
    PrintService.beginPrint();
    const finish = () => PrintService.endPrint();
    window.addEventListener("afterprint", finish, { once: true });
    try {
      window.print();
    } catch (error) {
      window.removeEventListener("afterprint", finish);
      PrintService.endPrint();
      throw error;
    }
    return true;
  }

  static printHtml(htmlContent: string, options: PrintOptions = {}): void {
    const {
      mode = "window",
      width = 500,
      height = 700,
      cleanupDelayMs = 30000,
      readyDelayMs = 100,
    } = options;

    PrintService.beginPrint();

    if (mode === "iframe") {
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.top = "-9999px";
      iframe.style.left = "-9999px";
      iframe.style.width = "1px";
      iframe.style.height = "1px";
      iframe.style.opacity = "0";
      iframe.style.border = "0";
      document.body.appendChild(iframe);

      let cleanupTimer: number | null = null;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (cleanupTimer !== null) window.clearTimeout(cleanupTimer);
        if (document.body.contains(iframe)) document.body.removeChild(iframe);
        PrintService.endPrint();
      };

      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      const printWindow = iframe.contentWindow;
      if (!doc || !printWindow) {
        cleanup();
        throw new Error("Не вдалося підготувати документ до друку.");
      }

      iframe.onload = () => {
        const start = async () => {
          try {
            await doc.fonts?.ready;
            printWindow.addEventListener("afterprint", cleanup, { once: true });
            printWindow.focus();
            printWindow.print();
            // Some printer drivers do not emit afterprint after cancellation.
            cleanupTimer = window.setTimeout(cleanup, cleanupDelayMs);
          } catch (error) {
            cleanup();
            console.error("Failed to print document", error);
          }
        };
        window.setTimeout(start, readyDelayMs);
      };

      try {
        doc.open();
        doc.write(htmlContent);
        doc.close();
      } catch (error) {
        cleanup();
        throw error;
      }
    } else {
      const printWindow = window.open("", "_blank", `width=${width},height=${height}`);
      if (!printWindow) {
        PrintService.endPrint();
        throw new Error("Браузер заблокував вікно друку. Дозвольте спливаючі вікна для цієї сторінки.");
      }

      let cleanupTimer: number | null = null;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (cleanupTimer !== null) window.clearTimeout(cleanupTimer);
        if (!printWindow.closed) printWindow.close();
        PrintService.endPrint();
      };

      printWindow.addEventListener("load", () => {
        const start = async () => {
          try {
            await printWindow.document.fonts?.ready;
            printWindow.addEventListener("afterprint", cleanup, { once: true });
            printWindow.focus();
            printWindow.print();
            cleanupTimer = window.setTimeout(cleanup, cleanupDelayMs);
          } catch (error) {
            cleanup();
            console.error("Failed to print document", error);
          }
        };
        window.setTimeout(start, readyDelayMs);
      }, { once: true });

      try {
        printWindow.document.open();
        printWindow.document.write(htmlContent);
        printWindow.document.close();
      } catch (error) {
        cleanup();
        throw error;
      }
    }
  }
}
