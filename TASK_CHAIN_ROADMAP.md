# TASK CHAIN — COMPLETE ROADMAP

## TASK-001 to TASK-300

### Phase Legend

| Phase | Range | Theme |
|-------|-------|-------|
| **MVP** | TASK-001 to TASK-120 | Core working system for one store |
| **EXPANSION** | TASK-121 to TASK-200 | Advanced features, automation, polish |
| **ELITE** | TASK-201 to TASK-260 | Analytics, optimization, intelligence |
| **SAAS** | TASK-261 to TASK-300 | Multi-tenant, billing, onboarding |

---

## PHASE: MVP (TASK-001 — TASK-120)

### Sprint 0: Project Foundation (TASK-001 — TASK-015)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-001 | Initialize monorepo with Turborepo + pnpm workspaces | infra | — | P0 |
| TASK-002 | Configure TypeScript strict mode across all packages | infra | 001 | P0 |
| TASK-003 | Create @packages/types with base entity interfaces | types | 002 | P0 |
| TASK-004 | Create @packages/ui skeleton with build config | ui | 002 | P0 |
| TASK-005 | Create @packages/api-client skeleton | api-client | 002 | P0 |
| TASK-006 | Initialize /server Express.js app with health endpoint | server | 002 | P0 |
| TASK-007 | Initialize /apps/web React + Vite app | web | 002 | P0 |
| TASK-008 | Set up Supabase project (local + remote) | supabase | — | P0 |
| TASK-009 | Configure ESLint + Prettier across monorepo | infra | 001 | P0 |
| TASK-010 | Set up GitHub Actions CI pipeline (lint + typecheck) | infra | 009 | P0 |
| TASK-011 | Create /docs folder structure with README | docs | — | P0 |
| TASK-012 | Create PROJECT_CONTEXT.md in repo root | docs | 011 | P0 |
| TASK-013 | Configure environment variables (.env.example + docs) | infra | 006,008 | P0 |
| TASK-014 | Set up Git branch protection rules | infra | 010 | P0 |
| TASK-015 | Create PR template and issue templates | infra | 014 | P0 |

### Sprint 1: Database Foundation (TASK-016 — TASK-030)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-016 | Create tenants table migration | db | 008 | P0 |
| TASK-017 | Create users table + user_role enum migration | db | 016 | P0 |
| TASK-018 | Create customers table migration | db | 016 | P0 |
| TASK-019 | Create customer_vehicles table migration | db | 018 | P0 |
| TASK-020 | Create categories + brands tables migration | db | 016 | P0 |
| TASK-021 | Create products table migration | db | 020 | P0 |
| TASK-022 | Create product_barcodes + product_aliases migrations | db | 021 | P0 |
| TASK-023 | Create suppliers table migration | db | 016 | P0 |
| TASK-024 | Create product_supplier_codes + product_analogs migrations | db | 021,023 | P0 |
| TASK-025 | Create inventory tables migration (receipts, writeoffs, reserves) | db | 021 | P0 |
| TASK-026 | Create sales + sale_items + shifts tables migration | db | 021,018 | P0 |
| TASK-027 | Create orders + order_items + order_attachments migration | db | 021,018,023 | P0 |
| TASK-028 | Create payments + cash_operations tables migration | db | 026,027 | P0 |
| TASK-029 | Create messages + leads tables migration | db | 018 | P0 |
| TASK-030 | Create RLS policies for all tables + enable RLS | db | 016-029 | P0 |

### Sprint 2: Auth Module (TASK-031 — TASK-040)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-031 | Implement Supabase Auth integration in server | auth | 006,017 | P0 |
| TASK-032 | Implement login endpoint (phone + password) | auth | 031 | P0 |
| TASK-033 | Implement JWT generation with role + tenant_id | auth | 032 | P0 |
| TASK-034 | Implement auth middleware (token validation) | auth | 033 | P0 |
| TASK-035 | Implement role guard middleware | auth | 034 | P0 |
| TASK-036 | Implement token refresh endpoint | auth | 033 | P0 |
| TASK-037 | Implement user registration (admin-only) | auth | 035 | P0 |
| TASK-038 | Implement change password endpoint | auth | 034 | P0 |
| TASK-039 | Build login page UI (web) | web | 007,032 | P0 |
| TASK-040 | Build auth state management in frontend (Zustand store) | web | 039 | P0 |

### Sprint 3: Products Core (TASK-041 — TASK-060)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-041 | Implement products CRUD service (server) | products | 021,034 | P1 |
| TASK-042 | Implement products CRUD routes + validation (Zod) | products | 041 | P1 |
| TASK-043 | Implement product search trigger + tsvector update | products | 041 | P1 |
| TASK-044 | Implement barcode lookup endpoint | products | 022,042 | P1 |
| TASK-045 | Implement universal search endpoint (barcode+SKU+OEM+name) | products | 043,044 | P1 |
| TASK-046 | Implement product analogs CRUD | products | 024,042 | P1 |
| TASK-047 | Implement product price history tracking | products | 042 | P1 |
| TASK-048 | Implement categories CRUD (admin) | admin | 020,035 | P1 |
| TASK-049 | Implement brands CRUD (admin) | admin | 020,035 | P1 |
| TASK-050 | Implement suppliers CRUD (admin) | admin | 023,035 | P1 |
| TASK-051 | Build products list page UI | web | 042,040 | P1 |
| TASK-052 | Build product detail/edit page UI | web | 051 | P1 |
| TASK-053 | Build product search component (used in POS and catalog) | web | 045 | P1 |
| TASK-054 | Build categories management UI | web | 048 | P1 |
| TASK-055 | Build brands management UI | web | 049 | P1 |
| TASK-056 | Build suppliers management UI | web | 050 | P1 |
| TASK-057 | Implement product_supplier_codes CRUD | products | 024,042 | P1 |
| TASK-058 | Build analog display component | web | 046 | P1 |
| TASK-059 | Implement product create form with barcode/alias management | web | 052 | P1 |
| TASK-060 | Implement product import from CSV | products | 042 | P2 |

### Sprint 4: Inventory Core (TASK-061 — TASK-075)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-061 | Implement inventory receipt service (create, confirm) | inventory | 025,041 | P1 |
| TASK-062 | Implement inventory receipt routes + validation | inventory | 061 | P1 |
| TASK-063 | Implement receipt confirmation (stock update transaction) | inventory | 062 | P1 |
| TASK-064 | Implement write-off service + routes | inventory | 025,041 | P1 |
| TASK-065 | Implement inventory reserve service | inventory | 025,041 | P2 |
| TASK-066 | Implement low stock query | inventory | 041 | P1 |
| TASK-067 | Build inventory receipts list UI | web | 062 | P1 |
| TASK-068 | Build receipt create/edit form UI | web | 067 | P1 |
| TASK-069 | Build receipt confirmation dialog | web | 068 | P1 |
| TASK-070 | Build write-off form UI | web | 064 | P1 |
| TASK-071 | Build low stock dashboard widget | web | 066 | P2 |
| TASK-072 | Implement inventory session service (stock count) | inventory | 025 | P2 |
| TASK-073 | Build inventory session UI (count entry) | web | 072 | P2 |
| TASK-074 | Implement dead stock detection query | inventory | 041 | P2 |
| TASK-075 | Build supplier invoice upload (file storage) | inventory | 062 | P2 |

### Sprint 5: POS Core (TASK-076 — TASK-095)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-076 | Build POS page layout (receipt panel + search panel) | pos | 007,040 | P1 |
| TASK-077 | Integrate universal search into POS search bar | pos | 053,076 | P1 |
| TASK-078 | Build receipt item list component with qty/price editing | pos | 076 | P1 |
| TASK-079 | Build add-to-receipt flow (search → click → add) | pos | 077,078 | P1 |
| TASK-080 | Build receipt totals calculation (subtotal, discount, total) | pos | 078 | P1 |
| TASK-081 | Implement sale create service (transaction: sale + items + inventory + payment) | sales | 026,041 | P1 |
| TASK-082 | Implement sale create route + validation | sales | 081 | P1 |
| TASK-083 | Build payment dialog (cash with change calc, card) | pos | 080 | P1 |
| TASK-084 | Build split payment dialog | pos | 083 | P1 |
| TASK-085 | Implement shift open/close service | sales | 026 | P1 |
| TASK-086 | Build shift open/close UI | pos | 085 | P1 |
| TASK-087 | Implement suspended receipts (save/load) | sales | 082 | P1 |
| TASK-088 | Build suspended receipts panel UI | pos | 087 | P1 |
| TASK-089 | Build receipt tabs (multiple open checks) | pos | 076 | P1 |
| TASK-090 | Build favorites panel in POS | pos | 076 | P2 |
| TASK-091 | Implement discount application with min price check | sales | 082 | P1 |
| TASK-092 | Build discount dialog with preset buttons | pos | 091 | P1 |
| TASK-093 | Implement min price override flow | sales | 091 | P1 |
| TASK-094 | Build customer quick-select in POS | pos | 076 | P1 |
| TASK-095 | Implement POS hotkeys | pos | 076-094 | P2 |

### Sprint 6: Customers Core (TASK-096 — TASK-108)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-096 | Implement customers CRUD service | customers | 018,034 | P2 |
| TASK-097 | Implement customers CRUD routes + validation | customers | 096 | P2 |
| TASK-098 | Implement customer search (phone, name, full-text) | customers | 097 | P2 |
| TASK-099 | Implement customer vehicles CRUD | customers | 019,097 | P2 |
| TASK-100 | Implement customer timeline aggregation | customers | 097 | P2 |
| TASK-101 | Implement debt tracking (increment on debt sale, decrement on repayment) | customers | 097,082 | P2 |
| TASK-102 | Implement quick customer create endpoint | customers | 097 | P1 |
| TASK-103 | Build customers list page UI | web | 097 | P2 |
| TASK-104 | Build customer detail page with timeline | web | 100 | P2 |
| TASK-105 | Build customer vehicles management UI | web | 099 | P2 |
| TASK-106 | Build customer debt summary view | web | 101 | P2 |
| TASK-107 | Build quick customer create modal (from POS) | web | 102,094 | P1 |
| TASK-108 | Implement debt sale flow in POS | pos | 101,094 | P2 |

### Sprint 7: Orders + Payments (TASK-109 — TASK-120)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-109 | Implement orders CRUD service | orders | 027,034 | P3 |
| TASK-110 | Implement order status transition service with validation | orders | 109 | P3 |
| TASK-111 | Implement order routes + validation | orders | 110 | P3 |
| TASK-112 | Build orders list page UI (filterable by status) | web | 111 | P3 |
| TASK-113 | Build order create/edit form UI | web | 112 | P3 |
| TASK-114 | Build order detail page with status history | web | 113 | P3 |
| TASK-115 | Implement order attachment upload | orders | 111 | P3 |
| TASK-116 | Implement payment recording service | payments | 028 | P4 |
| TASK-117 | Implement payment routes | payments | 116 | P4 |
| TASK-118 | Implement cash reconciliation service | payments | 116,085 | P4 |
| TASK-119 | Build payment history view | web | 117 | P4 |
| TASK-120 | **MVP CHECKPOINT — Full system integration test** | all | all | P0 |

---

## PHASE: EXPANSION (TASK-121 — TASK-200)

### Sprint 8: Messaging (TASK-121 — TASK-138)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-121 | Set up Telegram Bot (BotFather, webhook) | telegram | 008 | P5 |
| TASK-122 | Create Supabase Edge Function for Telegram webhook | telegram | 121 | P5 |
| TASK-123 | Implement inbound message processing pipeline | messages | 122,029 | P5 |
| TASK-124 | Implement lead creation from new conversations | messages | 123 | P5 |
| TASK-125 | Implement lead assignment (manual + round-robin) | messages | 124 | P5 |
| TASK-126 | Implement reply from CRM (outbound message via Telegram API) | messages | 123 | P5 |
| TASK-127 | Build messaging panel UI (inbox view) | web | 123 | P5 |
| TASK-128 | Build conversation thread view | web | 127 | P5 |
| TASK-129 | Build reply composer with send button | web | 128,126 | P5 |
| TASK-130 | Build lead board UI (new, assigned, in progress) | web | 125 | P5 |
| TASK-131 | Implement unprocessed lead alerts | messages | 125 | P5 |
| TASK-132 | Build alert notification component | web | 131 | P5 |
| TASK-133 | Implement manual message paste endpoint | messages | 123 | P5 |
| TASK-134 | Build manual paste form UI | web | 133 | P5 |
| TASK-135 | Implement Supabase Realtime subscription for new messages | web | 127 | P5 |
| TASK-136 | Implement lead-to-order conversion flow | messages | 125,109 | P5 |
| TASK-137 | Build lead conversion dialog | web | 136 | P5 |
| TASK-138 | Implement customer linking (Telegram user → customer record) | messages | 123,096 | P5 |

### Sprint 9: Reports (TASK-139 — TASK-152)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-139 | Implement sales report query (daily/weekly/monthly) | reports | 082 | P6 |
| TASK-140 | Build sales report page UI with charts | web | 139 | P6 |
| TASK-141 | Implement debts report query | reports | 101 | P6 |
| TASK-142 | Build debts report page UI | web | 141 | P6 |
| TASK-143 | Implement low stock report (v_low_stock view) | reports | 066 | P6 |
| TASK-144 | Build low stock report page UI | web | 143 | P6 |
| TASK-145 | Implement stuck orders report | reports | 110 | P6 |
| TASK-146 | Build stuck orders report page UI | web | 145 | P6 |
| TASK-147 | Implement cash mismatch report | reports | 118 | P6 |
| TASK-148 | Build cash mismatch report page UI | web | 147 | P6 |
| TASK-149 | Implement top products report | reports | 082 | P6 |
| TASK-150 | Build top products report page UI | web | 149 | P6 |
| TASK-151 | Implement unprocessed leads report | reports | 131 | P6 |
| TASK-152 | Build unprocessed leads report page UI | web | 151 | P6 |

### Sprint 10: POS Advanced (TASK-153 — TASK-170)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-153 | Implement return processing service | sales | 082 | P5 |
| TASK-154 | Build return dialog UI in POS | pos | 153 | P5 |
| TASK-155 | Implement cash in/out operations service | payments | 116,085 | P5 |
| TASK-156 | Build cash in/out dialog UI | pos | 155 | P5 |
| TASK-157 | Implement duplicate sale detection | sales | 082 | P6 |
| TASK-158 | Build duplicate sale warning dialog | pos | 157 | P6 |
| TASK-159 | Implement receipt note feature | sales | 082 | P6 |
| TASK-160 | Build receipt note input UI | pos | 159 | P6 |
| TASK-161 | Implement quick last sale (duplicate previous) | sales | 082 | P6 |
| TASK-162 | Build quick last sale button + dialog | pos | 161 | P6 |
| TASK-163 | Implement barcode scan sound effects | pos | 077 | P6 |
| TASK-164 | Implement internet status banner | web | 007 | P5 |
| TASK-165 | Implement PRRO status banner (placeholder) | pos | 076 | P6 |
| TASK-166 | Implement shift close report generation | sales | 085,118 | P5 |
| TASK-167 | Build shift close summary report UI | pos | 166 | P5 |
| TASK-168 | Build POS settings panel (sound, hotkeys, layout) | pos | 095 | P6 |
| TASK-169 | Implement change calculator in cash payment | pos | 083 | P5 |
| TASK-170 | Implement receipt printing (browser print or ESC/POS) | pos | 082 | P6 |

### Sprint 11: Order Advanced (TASK-171 — TASK-185)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-171 | Implement order from Telegram message flow | orders | 136 | P6 |
| TASK-172 | Implement unknown item request handling | orders | 109 | P6 |
| TASK-173 | Build unknown item order form | web | 172 | P6 |
| TASK-174 | Implement OEM/analog selection in order items | orders | 046,109 | P6 |
| TASK-175 | Build OEM/analog selector component for orders | web | 174 | P6 |
| TASK-176 | Implement supplier selection with speed/price scoring | orders | 050,109 | P6 |
| TASK-177 | Build supplier selection dialog | web | 176 | P6 |
| TASK-178 | Implement prepayment tracking on orders | orders | 116,109 | P6 |
| TASK-179 | Implement arrival notification flow | orders | 110 | P6 |
| TASK-180 | Implement promise timer (overdue detection cron) | orders | 110 | P6 |
| TASK-181 | Build overdue order alerts | web | 180 | P6 |
| TASK-182 | Implement order cancellation with reason tracking | orders | 110 | P6 |
| TASK-183 | Implement lost order analytics (reason aggregation) | reports | 182 | P7 |
| TASK-184 | Build lost order analytics chart | web | 183 | P7 |
| TASK-185 | Implement order attachment viewer (photos, voice) | web | 115 | P6 |

### Sprint 12: Customer Advanced (TASK-186 — TASK-200)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-186 | Implement customer bonus system (points accumulation) | customers | 097,082 | P7 |
| TASK-187 | Build bonus balance display + usage | web | 186 | P7 |
| TASK-188 | Implement customer tags management | customers | 097 | P6 |
| TASK-189 | Build customer tags UI | web | 188 | P6 |
| TASK-190 | Implement customer communication history (unified timeline) | customers | 100 | P6 |
| TASK-191 | Implement customer export to CSV | customers | 097 | P7 |
| TASK-192 | Implement customer merge (duplicate resolution) | customers | 097 | P7 |
| TASK-193 | Build customer merge UI | web | 192 | P7 |
| TASK-194 | Implement customer debt limit settings | customers | 101 | P6 |
| TASK-195 | Build debt limit configuration UI | web | 194 | P6 |
| TASK-196 | Implement customer purchase frequency analysis | reports | 097,082 | P7 |
| TASK-197 | Implement warranty claim tracking | orders | 109,096 | P7 |
| TASK-198 | Build warranty claim UI | web | 197 | P7 |
| TASK-199 | Implement return reason analytics | reports | 153 | P7 |
| TASK-200 | **EXPANSION CHECKPOINT — Full feature review** | all | all | P0 |

---

## PHASE: ELITE (TASK-201 — TASK-260)

### Sprint 13: VIN + Fitment (TASK-201 — TASK-215)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-201 | Implement VIN validation + checksum | fitment | — | P7 |
| TASK-202 | Implement VIN decode service (WMI/VDS/VIS parsing) | fitment | 201 | P7 |
| TASK-203 | Integrate external VIN decode API | fitment | 202 | P7 |
| TASK-204 | Implement clipboard image paste handler (web) | web | 007 | P7 |
| TASK-205 | Implement image crop UI for VIN area selection | web | 204 | P7 |
| TASK-206 | Integrate OCR service for VIN extraction from image | fitment | 205 | P7 |
| TASK-207 | Build VIN decode result display + save to vehicle | web | 203,099 | P7 |
| TASK-208 | Implement product_fitment CRUD | fitment | 021 | P7 |
| TASK-209 | Integrate external fitment API (TecDoc or equivalent) | fitment | 208 | P7 |
| TASK-210 | Implement fitment search (vehicle → compatible parts) | fitment | 209,045 | P7 |
| TASK-211 | Build fitment search UI (vehicle selector → results) | web | 210 | P7 |
| TASK-212 | Implement OEM → internal catalog cross-reference | fitment | 210,045 | P7 |
| TASK-213 | Build fitment results with stock/analog status | web | 212 | P7 |
| TASK-214 | Implement save VIN to customer vehicle flow | fitment | 207,099 | P7 |
| TASK-215 | Implement VIN photo from Telegram message processing | fitment | 206,123 | P8 |

### Sprint 14: Analytics + Intelligence (TASK-216 — TASK-235)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-216 | Implement frequently sold together analysis | analytics | 082 | P7 |
| TASK-217 | Build "customers also bought" suggestions in POS | pos | 216 | P7 |
| TASK-218 | Implement supplier speed score calculation | analytics | 109 | P7 |
| TASK-219 | Implement brand trust priority scoring | analytics | 049 | P8 |
| TASK-220 | Implement product movement velocity analysis | analytics | 082 | P8 |
| TASK-221 | Implement smart reorder suggestions | analytics | 066,220 | P8 |
| TASK-222 | Build reorder suggestions dashboard | web | 221 | P8 |
| TASK-223 | Implement customer segmentation (by spend, frequency) | analytics | 196 | P8 |
| TASK-224 | Build customer segments dashboard | web | 223 | P8 |
| TASK-225 | Implement cashier performance metrics | analytics | 082 | P8 |
| TASK-226 | Build cashier performance dashboard | web | 225 | P8 |
| TASK-227 | Implement revenue forecasting (basic trend) | analytics | 139 | P8 |
| TASK-228 | Build revenue forecast chart | web | 227 | P8 |
| TASK-229 | Implement profit margin analysis per product/category | analytics | 082,041 | P8 |
| TASK-230 | Build margin analysis dashboard | web | 229 | P8 |
| TASK-231 | Implement ABC analysis (products by revenue contribution) | analytics | 149 | P8 |
| TASK-232 | Build ABC analysis chart | web | 231 | P8 |
| TASK-233 | Implement customer lifetime value calculation | analytics | 196 | P8 |
| TASK-234 | Implement report export to PDF | reports | 139-152 | P8 |
| TASK-235 | Build report scheduler (email daily/weekly reports) | reports | 234 | P8 |

### Sprint 15: Desktop + Mobile (TASK-236 — TASK-250)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-236 | Initialize Electron app for desktop POS | desktop | 007 | P7 |
| TASK-237 | Integrate POS components into Electron renderer | desktop | 236,076 | P7 |
| TASK-238 | Implement local SQLite cache for offline POS | desktop | 237 | P7 |
| TASK-239 | Implement offline sale queue + sync on reconnect | desktop | 238 | P7 |
| TASK-240 | Implement crash recovery (restore unsaved receipts) | desktop | 239 | P7 |
| TASK-241 | Implement barcode scanner hardware integration | desktop | 237 | P7 |
| TASK-242 | Implement receipt printer integration (ESC/POS) | desktop | 237 | P8 |
| TASK-243 | Implement auto-update mechanism for Electron app | desktop | 236 | P8 |
| TASK-244 | Initialize mobile app (React Native or PWA) | mobile | 007 | P8 |
| TASK-245 | Build mobile dashboard (key metrics summary) | mobile | 244 | P8 |
| TASK-246 | Build mobile customer lookup | mobile | 244,097 | P8 |
| TASK-247 | Build mobile order management | mobile | 244,111 | P8 |
| TASK-248 | Build mobile messaging panel | mobile | 244,127 | P8 |
| TASK-249 | Build mobile notifications | mobile | 244 | P8 |
| TASK-250 | Build mobile inventory receipt confirmation | mobile | 244,062 | P8 |

### Sprint 16: Polish + Performance (TASK-251 — TASK-260)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-251 | Implement global error handling + error boundary | web | 007 | P6 |
| TASK-252 | Implement loading skeletons for all list pages | web | 007 | P7 |
| TASK-253 | Implement pagination + infinite scroll for all lists | web | 007 | P6 |
| TASK-254 | Optimize database queries (EXPLAIN ANALYZE, add indexes) | db | all | P6 |
| TASK-255 | Implement API rate limiting | server | 006 | P7 |
| TASK-256 | Implement request logging + audit trail | server | 006 | P7 |
| TASK-257 | Implement image optimization before storage upload | server | 006 | P8 |
| TASK-258 | Implement search result caching (Redis or in-memory) | server | 045 | P8 |
| TASK-259 | Add E2E tests for critical flows (sale, order, login) | testing | all | P7 |
| TASK-260 | **ELITE CHECKPOINT — Performance + stability review** | all | all | P0 |

---

## PHASE: SAAS (TASK-261 — TASK-300)

### Sprint 17: Multi-Tenant Infrastructure (TASK-261 — TASK-275)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-261 | Implement tenant provisioning service | saas | 016 | P9 |
| TASK-262 | Implement tenant-scoped API routing | saas | 261 | P9 |
| TASK-263 | Implement tenant settings management | saas | 261 | P9 |
| TASK-264 | Implement tenant data isolation verification | saas | 030 | P9 |
| TASK-265 | Implement multi-store support within tenant | saas | 261 | P9 |
| TASK-266 | Implement multi-warehouse support | saas | 265 | P9 |
| TASK-267 | Implement inter-store transfer (STO flow) | saas | 266 | P9 |
| TASK-268 | Implement STO Viewer role functionality | saas | 267 | P9 |
| TASK-269 | Implement B2B customer portal | saas | 261 | P9 |
| TASK-270 | Build tenant admin panel | web | 261 | P9 |
| TASK-271 | Build multi-store selector in UI | web | 265 | P9 |
| TASK-272 | Build multi-warehouse selector in UI | web | 266 | P9 |
| TASK-273 | Implement tenant-level backup automation | saas | 261 | P9 |
| TASK-274 | Implement tenant usage metrics | saas | 261 | P9 |
| TASK-275 | Implement tenant onboarding wizard | saas | 261 | P9 |

### Sprint 18: SaaS Features (TASK-276 — TASK-290)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-276 | Implement subscription plans (free, starter, pro, enterprise) | billing | 261 | P9 |
| TASK-277 | Implement feature flags per subscription tier | billing | 276 | P9 |
| TASK-278 | Integrate payment gateway for subscriptions | billing | 276 | P9 |
| TASK-279 | Build pricing page | web | 276 | P9 |
| TASK-280 | Build subscription management UI | web | 278 | P9 |
| TASK-281 | Implement self-service tenant registration | saas | 261,275 | P9 |
| TASK-282 | Build registration + onboarding flow UI | web | 281 | P9 |
| TASK-283 | Implement tenant data export (for portability) | saas | 261 | P9 |
| TASK-284 | Implement usage-based limits (products, users, storage) | billing | 277 | P9 |
| TASK-285 | Build usage dashboard for tenants | web | 284 | P9 |
| TASK-286 | Implement Viber bot integration | messages | 123 | P9 |
| TASK-287 | Build landing page for SaaS product | web | — | P9 |
| TASK-288 | Implement API documentation (Swagger/OpenAPI) | docs | 006 | P9 |
| TASK-289 | Implement webhook system for tenant integrations | saas | 261 | P9 |
| TASK-290 | Build integration marketplace UI | web | 289 | P9 |

### Sprint 19: Launch Preparation (TASK-291 — TASK-300)

| ID | Title | Module | Depends | Priority |
|----|-------|--------|---------|----------|
| TASK-291 | Security audit (penetration testing, RLS review) | security | all | P9 |
| TASK-292 | Performance load testing (simulate 50 concurrent users) | testing | all | P9 |
| TASK-293 | Implement monitoring + alerting (uptime, errors, latency) | infra | all | P9 |
| TASK-294 | Implement automated database backup verification | infra | 273 | P9 |
| TASK-295 | Create user documentation / help center | docs | all | P9 |
| TASK-296 | Create video tutorials for key flows | docs | 295 | P9 |
| TASK-297 | Implement feedback / support ticket system | saas | 261 | P9 |
| TASK-298 | SEO optimization for landing page | web | 287 | P9 |
| TASK-299 | Legal: Terms of Service, Privacy Policy | legal | — | P9 |
| TASK-300 | **SAAS LAUNCH CHECKPOINT — Go/No-Go review** | all | all | P0 |

---

## TASK FILE TEMPLATE

Each task should have its own file at `/docs/tasks/TASK-XXX.md` following this template:

```markdown
# TASK-XXX: [Title]

## Metadata
- **Module:** [module name]
- **Phase:** MVP | Expansion | Elite | SaaS
- **Priority:** P0-P9
- **Depends On:** TASK-YYY, TASK-ZZZ
- **Blocks:** TASK-AAA, TASK-BBB
- **Estimated Effort:** S (< 2h) | M (2-4h) | L (4-8h) | XL (> 8h)
- **Status:** Backlog | Ready | In Progress | Review | QA | Done | Merged

## Description
[Clear, detailed description of what needs to be built]

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Technical Notes
[Implementation guidance for the AI agent]

### Files to Create/Modify
- /server/src/services/xxx.ts
- /server/src/routes/xxx.ts
- /apps/web/src/pages/xxx.tsx

### Database Changes
- [Migration needed? Which tables?]

### API Contract
- [Endpoint, method, request body, response]

## QA Notes
- [Special testing considerations]
```

---

# ДОПОВНЕННЯ РОАДМАПУ — Нові модулі v2

## Правило критеріїв приймання (для всіх задач)

Кожна задача вважається ВИКОНАНОЮ тільки якщо:
- [ ] TypeScript компілюється без помилок (`tsc --noEmit`)
- [ ] ESLint без помилок (`pnpm lint`)
- [ ] Міграція виконана на локальному Supabase і таблиці створені
- [ ] API ендпоінт відповідає схемі зі SPEC файлу
- [ ] Власник протестував сценарій вручну і він працює
- [ ] CURRENT_TASK.md оновлено (статус done, наступна задача)
- [ ] CHANGELOG_AI.md має новий запис

---

## SPRINT 8: Ціноутворення (TASK-301 — TASK-315)

| ID | Назва | Залежить | Пріоритет |
|---|---|---|---|
| TASK-301 | Міграція: price_tiers, volume_discounts, category_markups | TASK-030 | P0 |
| TASK-302 | Міграція: ALTER customers (price_tier_id, bonus_balance_kopecks, risk_level) | TASK-018 | P0 |
| TASK-303 | Міграція: ALTER products (price_kopecks, purchase_price_kopecks, min_price_kopecks) | TASK-021 | P0 |
| TASK-304 | Міграція: ALTER tenants (owner_pin, allow_negative_stock, loyalty_enabled) | TASK-016 | P0 |
| TASK-305 | Backend: CRUD для price_tiers | TASK-301 | P0 |
| TASK-306 | Backend: category_markups CRUD + автонаценка при створенні товару | TASK-301, TASK-305 | P0 |
| TASK-307 | Backend: /api/pricing/calculate — сервіс розрахунку ціни | TASK-305, TASK-306 | P0 |
| TASK-308 | Backend: volume_discounts CRUD | TASK-301 | P1 |
| TASK-309 | POS: застосування ціни по рівню клієнта при відкритті чека | TASK-307 | P0 |
| TASK-310 | POS: PIN-захист при знижці нижче мін. ціни | TASK-307, TASK-309 | P0 |
| TASK-311 | UI: сторінка налаштування цінових рівнів (адмінка) | TASK-305 | P1 |
| TASK-312 | UI: налаштування наценок по категоріях | TASK-306 | P1 |
| TASK-313 | UI: obj'ємні знижки | TASK-308 | P2 |
| TASK-314 | UI: відображення маржі в картці товару (Owner/Admin) | TASK-303 | P1 |
| TASK-315 | UI: ціновий рівень і індивідуальна знижка в картці клієнта | TASK-302 | P1 |

### Критерії приймання Sprint 8

- [ ] TASK-307: POST /api/pricing/calculate повертає правильну ціну для комбінації клієнт + товар + кількість
- [ ] TASK-309: Клієнт з рівнем "СТО -10%" — в POS ціна підставляється автоматично
- [ ] TASK-310: Спроба дати знижку нижче min_price → запит PIN → без правильного PIN заблоковано
- [ ] TASK-314: Owner бачить закупівельну ціну і маржу, Cashier — не бачить

---

## SPRINT 9: Журнал постачальників (TASK-316 — TASK-325)

| ID | Назва | Залежить | Пріоритет |
|---|---|---|---|
| TASK-316 | Міграція: supplier_purchases, supplier_purchase_items | TASK-023 | P0 |
| TASK-317 | Міграція: supplier_returns, supplier_return_items | TASK-316 | P0 |
| TASK-318 | Міграція: supplier_warranty_claims | TASK-317 | P0 |
| TASK-319 | Backend: CRUD закупівель постачальника + summary ендпоінт | TASK-316 | P0 |
| TASK-320 | Backend: CRUD повернень постачальнику | TASK-317 | P0 |
| TASK-321 | Backend: CRUD гарантійних випадків | TASK-318 | P0 |
| TASK-322 | Backend: автостворення supplier_purchase при підтвердженні приймання | TASK-319, TASK-061 | P1 |
| TASK-323 | UI: картка постачальника з табами (Закупівлі / Повернення / Гарантія) | TASK-319 | P0 |
| TASK-324 | UI: форма фіксації закупівлі | TASK-319 | P0 |
| TASK-325 | UI: звіт статистики постачальників | TASK-319 | P2 |

### Критерії приймання Sprint 9

- [ ] TASK-319: Картка постачальника показує суму закупівель за 90 днів і кількість відкритих гарантій
- [ ] TASK-322: При підтвердженні приймання система питає "Зафіксувати як закупівлю?" і створює запис
- [ ] TASK-321: Гарантійний випадок можна перевести по всіх статусах від open до closed

---

## SPRINT 10: Імпорт накладної (TASK-326 — TASK-338)

| ID | Назва | Залежить | Пріоритет |
|---|---|---|---|
| TASK-326 | Міграція: import_sessions, import_session_rows | TASK-025 | P0 |
| TASK-327 | Backend: парсер Excel/CSV (SheetJS + PapaParse) | TASK-326 | P0 |
| TASK-328 | Backend: парсер clipboard text (евристика колонок) | TASK-326 | P0 |
| TASK-329 | Backend: нормалізація артикулів (remove spaces/dashes, uppercase) | TASK-327 | P0 |
| TASK-330 | Backend: пошук товару (exact → fuzzy → new) | TASK-329 | P0 |
| TASK-331 | Backend: POST /api/import/parse — повний флоу парсингу | TASK-327, TASK-330 | P0 |
| TASK-332 | Backend: POST /api/import/:id/confirm — створити накладну з сесії | TASK-331 | P0 |
| TASK-333 | UI: екран завантаження (drag-drop файл або вставка тексту) | TASK-331 | P0 |
| TASK-334 | UI: таблиця результатів (зелені/жовті/червоні секції) | TASK-331 | P0 |
| TASK-335 | UI: підтвердження жовтих рядків (вибір між варіантами) | TASK-334 | P0 |
| TASK-336 | UI: форма швидкого створення для червоних (нових) товарів | TASK-334 | P0 |
| TASK-337 | UI: збереження маппінгу колонок для постачальника | TASK-334 | P2 |
| TASK-338 | UI: кнопка "Режим приймання" — швидке додавання в накладну за 4 кроки | TASK-061 | P1 |

### Критерії приймання Sprint 10

- [ ] TASK-331: Вставити таблицю з сайту постачальника → система правильно витягує артикул, назву, кількість, ціну
- [ ] TASK-330: "BP-1234", "bp1234", "BP 1234" — всі три знаходять один і той самий товар
- [ ] TASK-332: Після підтвердження — накладна створена, залишки оновлені, supplier_purchase зафіксовано
- [ ] TASK-338: Новий товар від сканування до появи в накладній — менше 10 секунд

---

## SPRINT 11: Повернення від клієнта (TASK-339 — TASK-348)

| ID | Назва | Залежить | Пріоритет |
|---|---|---|---|
| TASK-339 | Міграція: customer_returns, customer_return_items | TASK-026, TASK-318 | P0 |
| TASK-340 | Backend: перевірка права на повернення (строк, наявність у базі) | TASK-339 | P0 |
| TASK-341 | Backend: POST /api/returns — створити повернення | TASK-340 | P0 |
| TASK-342 | Backend: логіка дій з товаром (на склад / списати / до постачальника) | TASK-341 | P0 |
| TASK-343 | Backend: логіка повернення грошей (готівка / термінал / борг) | TASK-341 | P0 |
| TASK-344 | Backend: автостворення supplier_warranty_claim при типі warranty_supplier | TASK-341, TASK-321 | P1 |
| TASK-345 | UI: екран повернення (пошук чека → вибір позицій → причина → дія) | TASK-341 | P0 |
| TASK-346 | UI: акт повернення для друку | TASK-345 | P1 |
| TASK-347 | UI: список повернень з фільтрами | TASK-341 | P1 |
| TASK-348 | UI: звіт причин повернень | TASK-347 | P2 |

### Критерії приймання Sprint 11

- [ ] TASK-340: Повернення товару куленого > 14 днів тому → попередження (дозволяє з PIN)
- [ ] TASK-342: stock_action = 'return_to_stock' → qty_on_hand збільшується
- [ ] TASK-342: stock_action = 'write_off' → inventory_writeoffs запис, qty НЕ збільшується
- [ ] TASK-343: refund_method = 'cash' → cash_operations запис зменшує касу

---

## SPRINT 12: Лояльність і захист (TASK-349 — TASK-368)

| ID | Назва | Залежить | Пріоритет |
|---|---|---|---|
| TASK-349 | Міграція: loyalty_settings, loyalty_transactions | TASK-302 | P1 |
| TASK-350 | Міграція: customer_notes | TASK-302 | P1 |
| TASK-351 | Міграція: audit_log, product_not_duplicate_pairs | TASK-016 | P0 |
| TASK-352 | Backend: нарахування бонусів при завершенні продажу | TASK-349 | P1 |
| TASK-353 | Backend: списання бонусів у POS | TASK-352 | P1 |
| TASK-354 | Backend: автоматичний ризик-профіль клієнта | TASK-302 | P1 |
| TASK-355 | Backend: audit_log middleware — логування змін цін і анулювань | TASK-351 | P0 |
| TASK-356 | Backend: антидублікат при створенні товару (артикул + trigram назви) | TASK-351 | P0 |
| TASK-357 | Backend: захист від від'ємного залишку | TASK-304 | P0 |
| TASK-358 | Backend: звірка каси при закритті зміни | TASK-351 | P0 |
| TASK-359 | Backend: dead stock view (товари без руху N днів) | TASK-351 | P1 |
| TASK-360 | UI: нотатки клієнта (список + додати + закріпити + колір) | TASK-350 | P1 |
| TASK-361 | UI: popup нотатки при прив'язці клієнта в POS | TASK-360 | P1 |
| TASK-362 | UI: бонуси в POS — показ балансу і кнопка списання | TASK-353 | P1 |
| TASK-363 | UI: налаштування програми лояльності (адмінка) | TASK-349 | P2 |
| TASK-364 | UI: лог дій персоналу з фільтрами | TASK-355 | P1 |
| TASK-365 | UI: звірка каси при закритті зміни (факт vs система) | TASK-358 | P0 |
| TASK-366 | UI: ризик-значок в картці клієнта і попередження в POS | TASK-354 | P1 |
| TASK-367 | UI: звіт "Мертвий стік" з масовою уцінкою | TASK-359 | P2 |
| TASK-368 | UI: налаштування дизайн-системи (SPEC_DESIGN_SYSTEM.md) — Tailwind config | TASK-004 | P0 |

### Критерії приймання Sprint 12

- [ ] TASK-352: Продаж на 1000 грн при accrual_pct=2% → клієнту нараховано 20 грн бонусів
- [ ] TASK-353: Списання 50 грн бонусів → сума чека зменшилась на 50 грн, баланс клієнта -50 грн
- [ ] TASK-356: Ввести артикул існуючого товару → показати попередження з посиланням на картку
- [ ] TASK-357: Спроба продати товар з qty=0 → попередження, без PIN → заблоковано
- [ ] TASK-358: Фактична каса 3285 грн vs розрахункова 3300 грн → розбіжність -15 грн зафіксована з причиною
- [ ] TASK-368: Акцентний колір #FFD000 застосований у всьому UI, POS в темній темі

---

## SPRINT 13: Дашборд і автосповіщення (TASK-369 — TASK-380)

| ID | Назва | Залежить | Пріоритет |
|---|---|---|---|
| TASK-369 | Міграція: notification_triggers | TASK-029 | P2 |
| TASK-370 | Backend: GET /api/dashboard — агрегована статистика дня | TASK-080, TASK-095 | P1 |
| TASK-371 | Backend: Telegram тригер order_arrived → авто-повідомлення клієнту | TASK-369 | P2 |
| TASK-372 | Backend: Telegram тригер order_overdue → алерт менеджеру | TASK-369 | P2 |
| TASK-373 | Backend: Telegram тригер debt_overdue → алерт менеджеру | TASK-369 | P2 |
| TASK-374 | UI: дашборд власника (виручка / замовлення / каса / повідомлення) | TASK-370 | P1 |
| TASK-375 | UI: налаштування тригерів сповіщень (адмінка) | TASK-369 | P2 |
| TASK-376 | UI: друк етикеток після приймання (SheetJS → thermal print) | TASK-332 | P2 |
| TASK-377 | UI: комерційна пропозиція для клієнта (вибір товарів → PDF) | TASK-307 | P2 |
| TASK-378 | Backend: шаблони повторних замовлень (зберегти список → повторити) | TASK-316 | P3 |
| TASK-379 | UI: прогноз запасів (вистачить на N днів за темпом продажів) | TASK-370 | P3 |
| TASK-380 | UI: API для сайту/каталогу — публічні ендпоінти товарів і залишків | TASK-045 | P3 |

### Критерії приймання Sprint 13

- [ ] TASK-370: Дашборд показує виручку сьогодні, кількість відкритих замовлень, залишок у касі
- [ ] TASK-371: Замовлення перейшло в статус 'arrived' → клієнт отримав Telegram повідомлення автоматично
- [ ] TASK-374: Власник бачить всю ключову інформацію на одному екрані без переходів

---

## Зведена таблиця нових спринтів

| Sprint | Задачі | Модуль | Пріоритет |
|---|---|---|---|
| Sprint 8 | TASK-301–315 | Ціноутворення | MVP |
| Sprint 9 | TASK-316–325 | Журнал постачальників | MVP |
| Sprint 10 | TASK-326–338 | Імпорт накладної | MVP |
| Sprint 11 | TASK-339–348 | Повернення | MVP |
| Sprint 12 | TASK-349–368 | Лояльність + Захист + Дизайн | MVP/Expansion |
| Sprint 13 | TASK-369–380 | Дашборд + Сповіщення | Expansion |

**Всього нових задач: 80 (TASK-301 — TASK-380)**
**Загальний роадмап: 380 задач**
