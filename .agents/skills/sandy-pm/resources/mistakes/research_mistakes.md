# Past Mistakes for Agent Type: research

This file tracks mistakes and guidelines for research and discovery subagents across `D:\Process`.

---

### 1. Source-of-Truth Verification
- **Mistake:** Relying on markdown summaries or outdated documentation rather than reading active canonical source files (e.g. `package.json`, `.env.example`, `test_wallets.json`, or live code implementations).
  - **Resolution:** ALWAYS inspect the primary source-of-truth configuration or code files directly before making architectural proposals.

### 2. On-Chain & API Contract Confirmation
- **Mistake:** Proposing contract methods or API integration code without checking actual deployed contract IDL / RPC endpoints / library versions.
  - **Resolution:** Verify exact method signatures and library versions in the workspace before generating integration patterns.
