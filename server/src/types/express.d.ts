declare namespace Express {
  interface Request {
    user?: {
      id: string
      email: string
      role: string
      tenant_id: string
    }
  }
}
