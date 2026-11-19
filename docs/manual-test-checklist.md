# รายการตรวจสอบการทดสอบด้วยตนเอง (Manual Pre-Flight Verification Checklist)

คู่มือตรวจสอบการทำงานแบบครบวงจร (End-to-End) สำหรับ **GitLab On-Demand Sync** บน Obsidian Desktop, Obsidian Mobile และ GitLab repository ส่วนตัว

## 1. การ Build และติดตั้ง Plugin

- [ ] รันคำสั่งตรวจสอบอัตโนมัติให้ผ่านก่อน:
  ```bash
  npm test
  npm run build
  node -c main.js
  ```
- [ ] เตรียม GitLab test repository แบบส่วนตัวที่มีโน้ต (`.md`), ไฟล์ `.canvas`/`.txt` (ถ้ามี) และไฟล์รูปภาพหลายไฟล์ในโฟลเดอร์ `attachments/` (รวมถึงโฟลเดอร์ย่อยและชื่อไฟล์ที่มีช่องว่างหรือวงเล็บ)
- [ ] สร้าง GitLab Personal Access Token โดยกำหนดสิทธิ์ `api` (หรือ `read_repository` + `write_repository`)
- [ ] คัดลอกไฟล์ `main.js`, `manifest.json` และ `styles.css` ไปวางไว้ที่ `<vault>/.obsidian/plugins/gitlab-ondemand-sync/` ทั้งใน Vault ทดสอบบน Desktop และ Mobile
- [ ] เปิด **Settings -> Community plugins** แล้วเปิดใช้งาน **GitLab On-Demand Sync** จากนั้นตั้งค่า:
  - **GitLab Base URL** (เช่น `https://gitlab.com`)
  - **Project ID / Path** (รหัสตัวเลขหรือ `username/vault-repo`)
  - **Branch** (เช่น `main`)
  - **Personal Access Token**
  - **Attachment Folder** (เช่น `attachments` หรือปล่อยว่างเพื่อใช้ root ของ Vault)
  - **Enable on Desktop (Testing)** (เปิด `ON` เฉพาะตอนทดสอบบน Desktop; ปกติให้ปิด `OFF` เพื่อใช้ `git` บน Desktop ตามปกติ)

## 2. การ Pull ครั้งแรกใน Vault ว่าง และระบบป้องกันไฟล์ทับ (Fail-Safe Guard)

- [ ] **ระบบป้องกัน Vault ไม่ว่าง (Non-empty vault guard):** ใน Vault ที่มีไฟล์ `.md` อยู่แล้วและยังไม่เคยซิงค์มาก่อน ให้กด **Sync with GitLab** (จากไอคอนแถบด้านข้างหรือ Command Palette) แล้วตรวจว่าคำสั่งหยุดทำงานพร้อมแจ้ง `Initial sync requires an empty vault; existing local text files detected.` โดยไม่เขียนทับไฟล์เดิม
- [ ] **การ Pull ใน Vault ว่าง (Empty-vault pull):** ใน Vault ว่างที่สร้างใหม่ ให้กด **Sync with GitLab**
  - ตรวจว่า Notice แสดง `GitLab sync complete: <N> pulled, 0 pushed, 0 deleted.`
  - ตรวจว่าไฟล์ข้อความตาม allowlist (`.md`, `.canvas`, `.txt`) ถูกเขียนลงใน Vault เรียบร้อย
  - ตรวจว่าไฟล์รูปภาพและโฟลเดอร์ขึ้นต้นด้วยจุด (เช่น `.git/`, `.vscode/`) **ไม่ถูก** เขียนลงในเครื่อง

## 3. การแสดงผลรูปภาพแบบ On-Demand และตรวจสอบขนาดพื้นที่จัดเก็บ

- [ ] เปิดโน้ตที่ซิงค์มาซึ่งมีลิงก์รูปภาพรูปแบบ `![[image.png]]`, `![[image.png|caption|300]]` และ `![alt|240](sub/photo(1).png)`
- [ ] ตรวจสอบใน **Live Preview**:
  - รูปภาพแสดงผลในโน้ตเมื่อเคอร์เซอร์อยู่นอกโค้ด embed
  - เมื่อเลื่อนเคอร์เซอร์เข้าไปในโค้ด embed จะกางเป็นข้อความ markdown ดิบ และเมื่อเลื่อนออกจะกลับมาแสดงรูปภาพเหมือนเดิม
  - เมื่อสลับเป็น **Source Mode** จะแสดงเฉพาะข้อความ markdown ดิบเท่านั้น
  - ลิงก์รูปภาพที่อยู่ใน inline backticks หรือ fenced code blocks จะยังคงแสดงเป็นโค้ดข้อความตามปกติ
- [ ] ตรวจสอบใน **Reading View**:
  - รูปภาพแสดงผลพร้อม alt text และจำกัดความกว้างถูกต้อง (`max-width: 100%`)
  - เปิดโน้ตยาวๆ ที่มีรูปภาพระยะไกล 10+ รูป พร้อมสังเกต Network activity ขณะเลื่อนหน้าจอ: รูปภาพที่อยู่นอกหน้าจอจะถูกโหลดเฉพาะเมื่อเลื่อนเข้ามาใน viewport เท่านั้น
- [ ] **ตรวจสอบว่าไม่มีการเก็บไฟล์รูปลงเครื่อง (Zero disk storage):** หลังจากเปิดดูโน้ตที่มีรูปภาพหลายไฟล์บน Mobile (และ Vault ทดสอบบน Desktop) ให้ตรวจสอบขนาดโฟลเดอร์ Vault ในตัวจัดการไฟล์ของเครื่อง (iOS Files / Android Files / Explorer):
  - ตรวจว่าไม่มีไฟล์รูปภาพถูกสร้างอยู่ในโฟลเดอร์ Vault (ขนาดรวมของ Vault ต้องมีเพียงขนาดไฟล์โน้ตข้อความและไฟล์ plugin เท่านั้น)
- [ ] ปิดโน้ตหรือปิด/โหลด plugin ใหม่ แล้วตรวจว่าสามารถเปิดดูรูปซ้ำได้ปกติโดยไม่เกิด error หรือใช้หน่วยความจำค้างสะสม

## 4. ระบบป้องกันเมื่อวางรูปขณะออฟไลน์ (Offline Paste Fail-Safe)

- [ ] ปิดการเชื่อมต่ออินเทอร์เน็ตของอุปกรณ์ (เปิดโหมดเครื่องบิน หรือปิด Wi-Fi)
- [ ] วาง (Paste) หรือลากวาง (Drag-and-drop) รูปภาพลงในโน้ตที่เปิดอยู่ในโหมด Live Preview
- [ ] ตรวจสอบว่า:
  - มี Notice แจ้ง `Failed to upload image to GitLab: ...`
  - ข้อความชั่วคราว `<!-- uploading-gitlab-image-... -->` ถูกลบออก และไม่มีลิงก์เสีย `![[...]]` หลงเหลือในโน้ต
  - ไม่มีไฟล์รูปภาพถูกสร้างลงในโฟลเดอร์ Vault บนเครื่อง

## 5. การอัปโหลดรูปจากกล้อง / คลังภาพบน Mobile (Mobile Camera / Photo Picker Upload)

- [ ] เชื่อมต่ออินเทอร์เน็ตบน Mobile อีกครั้ง แล้วเปิดโน้ตในโหมด Live Preview
- [ ] ใช้ปุ่มแถบเครื่องมือของ Obsidian Mobile (**Insert attachment / Camera / Photo library**) เพื่อเพิ่มรูปภาพ
- [ ] ตรวจสอบว่า:
  - Plugin อัปโหลดรูปภาพไปยัง GitLab โดยตรง (`<Attachment Folder>/Pasted image <YYYYMMDDHHmmss>.<ext>`)
  - ไฟล์รูปชั่วคราวที่ Obsidian สร้างไว้ในเครื่องถูกลบออกจากพื้นที่จัดเก็บของ Mobile ทันที
  - ลิงก์ในโน้ตอัปเดตเป็น `![[<Attachment Folder>/Pasted image <YYYYMMDDHHmmss>.<ext>]]` และแสดงรูปภาพได้ทันทีจาก `blob:` cache ในหน่วยความจำ
  - กด **Sync with GitLab** เพื่อ push ข้อความโน้ตที่อัปเดต จากนั้นลอง pull บน Desktop เพื่อตรวจว่าทั้งโน้ตและไฟล์รูปภาพถูก commit เข้าสู่ git เรียบร้อย

## 6. การทำ 3-Way Merge บน Desktop และการกู้คืนสถานะ Conflict (Conflict Recovery)

- [ ] สร้างสถานการณ์ conflict เพื่อทดสอบ:
  1. บน Desktop แก้ไขไฟล์ `conflict-test.md` แล้ว commit และ `git push` ขึ้น `main`
  2. บน Mobile (ก่อนกดซิงค์) แก้ไขไฟล์ `conflict-test.md` ให้ต่างกัน แล้วกด **Sync with GitLab**
- [ ] ตรวจว่า Mobile แสดงข้อความ `GitLab sync conflict! Local changes were pushed to branch "mobile-conflict/<timestamp>"...`
- [ ] ปิดและเปิดแอป Obsidian Mobile ใหม่ (ขณะที่ยังมีสถานะ conflict ค้างอยู่) แล้วตรวจว่ามี Notice แจ้งเตือนตอนเปิดแอปเกี่ยวกับ branch `mobile-conflict/...` ที่ค้างอยู่และให้กด **Clear Conflict State**
- [ ] บน Desktop ให้ดึงและรวม branch ที่มี conflict:
  ```bash
  git fetch origin
  git merge origin/mobile-conflict/<timestamp>
  # แก้ไข conflict markers ในไฟล์ conflict-test.md หากระบบแจ้ง จากนั้น:
  git add conflict-test.md
  git commit
  git push origin main
  ```
  (สามารถลองลบ branch `mobile-conflict/<timestamp>` บน GitLab หลัง merge เพื่อทดสอบการกู้คืนกรณี branch ถูกลบไปแล้วได้ด้วย)
- [ ] บน Mobile เปิด **Settings -> GitLab On-Demand Sync** แล้วกดปุ่ม **Clear Conflict State**:
  - ตรวจว่า Notice แสดง `GitLab conflict state cleared.` และปุ่มเปลี่ยนเป็นสถานะ disabled
  - กด **Sync with GitLab** แล้วตรวจว่า Mobile ปรับสถานะให้ตรงกับ `main` ที่ merge แล้วได้เรียบร้อย (`GitLab sync complete: ...`)
