# New Project Initiation & Architecture Rules (New Project Rules)

Rules from CEO Obsidian Vault: `Work/New Project Rule/New Project Rule.md`

1. **Zero Raw Emojis (Font Awesome or Lucide Only)**
   - ห้ามใช้ Raw Unicode Emojis ใน UI ให้ใช้ Font Awesome หรือ Lucide Icons (`<i data-lucide="..."></i>`) แทนเสมอ เพื่อความเนี๊ยบระดับ Professional
2. **Design Specification First (`design.md`)**
   - ต้องเขียนเอกสาร `design.md` สรุป Architecture, Color Palette, User Flow, Component Hierarchy ให้เรียบร้อยก่อนเริ่มเขียนโค้ด
3. **Logo Design Pre-requisite**
   - สร้างหรือกำหนด Brand Logo ให้พร้อมก่อนเริ่มลงมือสร้างระบบ
4. **HTML Mockup Design Prototype**
   - สร้างไฟล์ HTML Mockup Design ต้นแบบ เพื่อให้เห็นภาพ Visual UX/UI ชัดเจนก่อนพัฒนา Feature จริง
5. **Security-First `.gitignore`**
   - สร้าง `.gitignore` แบบเน้นความปลอดภัย (Security-first) ตั้งแต่เริ่มต้นโปรเจกต์ ป้องกัน Secret, Cache, และ Sensitive files รั่วไหล
6. **Dedicated `.secret` Directory with Git Exclusion**
   - ต้องสร้างโฟลเดอร์ `.secret/` เพื่อเก็บ Credential, API Keys, และ Password ต่างๆ ที่ใช้ระหว่าง Development และต้องมั่นใจว่าเพิ่ม `.secret` ลงใน `.gitignore` เรียบร้อยแล้ว
7. **Dual-Database Strategy (SQLite Local, Suitable DB Engine Prod)**
   - Database Strategy: ใช้ SQLite ใน Local Development เพื่อความรวดเร็วและคล่องตัว และเลือกใช้ DB Engine ตามความเหมาะสมใน Production (เช่น PostgreSQL, MySQL หรือตามความต้องการของระบบ)
8. **Built-in Marketing Blog**
   - ทุกโปรเจกต์ควรมีระบบหรือหน้า Blog เตรียมไว้สำหรับ Content Marketing, SEO, และการทำการตลาด
9. **Bug Report & Feature Request Channels**
   - ต้องมีช่องทางสื่อสารสำหรับรับ Feedback, แจ้งข้อผิดพลาด (Bug Report), และขอฟังก์ชันใหม่ (New Feature Request) ไว้ในระบบ
10. **Comprehensive CRUD + Search + Filter + Pagination**
    - ข้อมูลทุก Entity ในระบบต้องมีฟังก์ชันครบถ้วน: Create, Update, Delete, Edit, Search, Filter, และ Pagination
11. **Multi-Language Support (i18n Starting with TH & EN)**
    - ระบบเว็บต้องรองรับมากกว่า 2 ภาษาขึ้นไป โดยต้องเริ่มจากภาษาไทย (TH) และภาษาอังกฤษ (EN) เป็นมาตรฐานตั้งแต่วันแรก
