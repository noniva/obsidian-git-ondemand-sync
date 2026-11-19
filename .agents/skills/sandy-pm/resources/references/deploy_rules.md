# Deployment & Production Release Rules (Deploy Rules)

Rules from CEO Obsidian Vault: `Work/New Project Rule/Deploy Rule.md`

1. **Database Preservation & Rollback Plan**
   - ห้ามลบ DB เดิมเด็ดขาด ถ้าจะมีการแก้ไข Schema/Migration ต้อง Backup ข้อมูลเดิมก่อนเสมอ และต้องมี Rollback script ที่ย้อนกลับไปยังจุดก่อน Deploy ได้อย่างปลอดภัย
2. **Deploy Script Data Overwrite Guard**
   - ระวัง Database Migration / Deployment Script อย่าให้เขียนทับ (overwrite) ข้อมูลบน Production Server จนทำให้ข้อมูลลูกค้าสูญหาย
3. **Pre-Deploy Port Availability Check**
   - ตรวจสอบ Port ก่อน Deploy เสมอว่าว่างหรือไม่ มี process อื่นใช้งานอยู่หรือไม่
4. **Domain & Web Server Readiness**
   - ตรวจสอบ Web Server (Nginx, Caddy, Cloudflare ฯลฯ) ว่าผูก Domain เรียบร้อยและชี้เป้าถูกต้อง
5. **SSL Certificate & Auto-Renewal**
   - ตรวจสอบว่ามี SSL Certificate ติดตั้งสมบูรณ์แล้ว และมีระบบ Auto-Regenerate SSL (เช่น Certbot systemd timer หรือ Let's Encrypt renewal hook)
6. **Reboot & Crash Resilience**
   - ตรวจสอบว่าหากเครื่อง Server มีการ Restart (Reboot) แล้ว Service / App จะสามารถ Auto-Start กลับมาทำงานต่อได้ทันที (เช่น ผ่าน PM2 startup, systemd service, หรือ Docker restart policy `unless-stopped`/`always`)
7. **Staging vs Production Port & Service Isolation**
   - หาก Staging และ Production รันอยู่บน Server เครื่องเดียวกัน ต้องแยก Service Port, Environment File, และ Database Instance อย่างเด็ดขาด ป้องกันการชนกัน
8. **Pre-Deploy Internal Error Pre-Flight**
   - ตรวจสอบและรัน Test เช็ค Internal Errors ทั้งหมดให้ผ่าน 100% ก่อนเริ่มขั้นตอน Deploy
9. **Mandatory Post-Deploy HTTPS Curl Verification**
   - ทุกครั้งที่ Deploy เสร็จสิ้น ต้องรันคำสั่ง `curl -IsS https://<domain>` ตรวจสอบ Endpoint จริงทั้งจากภายนอก (External) และภายใน (Local) ให้ได้ **HTTP Status 200 OK** ก่อนส่งมอบงานให้คุณ CEO ห้ามปล่อยให้เว็บดับหรือติด 502/500 เด็ดขาด!
