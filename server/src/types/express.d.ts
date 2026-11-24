declare namespace Express {
  interface Request {
    user?: {
      id: string
      email: string
      role: string
      tenant_id: string
    }
    /** 24.11.2026: запит головного ПК власним ключем від імені працівника каси (routes/tillDevice.ts). Ставить лише сервер. */
    tillDeviceActor?: {
      id: string
      email: string
      role: string
      tenant_id: string
    }
  }
}
