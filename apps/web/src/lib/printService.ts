export interface PrintOptions {
  mode?: "window" | "iframe";
  title?: string;
  width?: number;
  height?: number;
  pageSizeMm?: { width: number; height: number };
  preferDesktopNative?: boolean;
  showDesktopPreview?: boolean;
  /** Друкувати на папері за налаштуванням драйвера (не задавати pageSize) —
   * для етикеткового HL80, який відхиляє власний pageSize («Invalid printer settings»). */
  useDriverPaper?: boolean;
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

  private static notifyPrintError(error: unknown, fallbackMessage = "Помилка друку"): void {
    const message = error instanceof Error ? error.message : fallbackMessage;
    import("@/components/ui/Toast").then(({ toast }) => toast.error(message));
  }

  /**
   * Browser print preview can be created before data-URL images are decoded.
   * Thermal labels then contain the barcode digits but no bars. Wait for every
   * printable image and two paint frames before opening the system dialog.
   */
  private static async waitForPrintableResources(
    doc: Document,
    printWindow: Window,
    timeoutMs = 5000,
  ): Promise<void> {
    await doc.fonts?.ready;

    const waitForImage = async (image: HTMLImageElement) => {
      if (!image.complete) {
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(
            () => reject(new Error("Зображення штрихкоду не завантажилося вчасно.")),
            timeoutMs,
          );
          image.addEventListener("load", () => {
            window.clearTimeout(timeout);
            resolve();
          }, { once: true });
          image.addEventListener("error", () => {
            window.clearTimeout(timeout);
            reject(new Error("Не вдалося завантажити зображення штрихкоду."));
          }, { once: true });
        });
      }

      if (typeof image.decode === "function") {
        await image.decode();
      }
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        throw new Error("Зображення штрихкоду порожнє.");
      }
    };

    await Promise.all(Array.from(doc.images).map(waitForImage));
    await Promise.race([
      new Promise<void>((resolve) => {
        printWindow.requestAnimationFrame(() => {
          printWindow.requestAnimationFrame(() => resolve());
        });
      }),
      new Promise<void>((resolve) => window.setTimeout(resolve, 100)),
    ]);
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
      pageSizeMm,
      preferDesktopNative = false,
      showDesktopPreview = false,
      useDriverPaper = false,
      cleanupDelayMs = 30000,
      readyDelayMs = 100,
    } = options;

    const desktopPrint = typeof window !== "undefined" ? window.forsageDesktop?.print : undefined;
    if (preferDesktopNative && pageSizeMm && desktopPrint) {
      PrintService.beginPrint();
      desktopPrint.html(htmlContent, {
        title: options.title,
        widthMm: pageSizeMm.width,
        heightMm: pageSizeMm.height,
        silent: false,
        showPreviewWindow: showDesktopPreview,
        useDriverPaper,
      }).then(() => {
        PrintService.endPrint();
      }).catch((error: unknown) => {
        console.error("Failed to print document through desktop bridge", error);
        PrintService.endPrint();
        import("@/components/ui/Toast").then(({ toast }) => {
          toast.error(error instanceof Error ? error.message : "Помилка локального друку");
        });
        window.setTimeout(() => {
          try {
            PrintService.printHtml(htmlContent, {
              ...options,
              preferDesktopNative: false,
            });
          } catch (fallbackError) {
            console.error("Failed to open browser print fallback", fallbackError);
            import("@/components/ui/Toast").then(({ toast }) => {
              toast.error(fallbackError instanceof Error ? fallbackError.message : "Помилка друку");
            });
          }
        }, 50);
      });
      return;
    }

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
            await PrintService.waitForPrintableResources(doc, printWindow);
            printWindow.addEventListener("afterprint", cleanup, { once: true });
            printWindow.focus();
            printWindow.print();
            // Some printer drivers do not emit afterprint after cancellation.
            cleanupTimer = window.setTimeout(cleanup, cleanupDelayMs);
          } catch (error) {
            cleanup();
            console.error("Failed to print document", error);
            PrintService.notifyPrintError(error);
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
            await PrintService.waitForPrintableResources(printWindow.document, printWindow);
            printWindow.addEventListener("afterprint", cleanup, { once: true });
            printWindow.focus();
            printWindow.print();
            cleanupTimer = window.setTimeout(cleanup, cleanupDelayMs);
          } catch (error) {
            cleanup();
            console.error("Failed to print document", error);
            PrintService.notifyPrintError(error);
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
