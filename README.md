# 🏭 Factory SNMP Network Monitor (Enterprise NMS Web App)

[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D16.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero%20(Pure%20Native)-00f0ff)](https://nodejs.org)
[![Protocol](https://img.shields.io/badge/Protocols-SNMP%20v1%2Fv2c%20%7C%20TCP%20%7C%20UDP-3b82f6)](#)
[![Docker](https://img.shields.io/badge/Docker-Supported-2496ed?logo=docker&logoColor=white)](#)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Hệ thống Web App giám sát mạng nhà máy thời gian thực độc lập (Enterprise NMS Web App) chạy trực tiếp trên nền tảng **Node.js Native** (Zero External NPM Dependencies), không phụ thuộc Home Assistant hay bất kỳ phần mềm trung gian nào. 

Toàn bộ sơ đồ Topo mạng, phân xưởng, thiết bị (Firewall, Switch Core, Access Switch, Wi-Fi Controller, AP, NAS, NVR, UPS), lưu lượng băng thông thời gian thực và cảnh báo Telegram đều được **thao tác, cấu hình và quét thực tế trực tiếp từ giao diện Web**.

---

## 🌟 TÍNH NĂNG NỔI BẬT

### 1. 📡 Nhận Diện Card Mạng & Quét Mạng Trực Tiếp (Live NMS Scanner)
- **Tự động nhận diện Card mạng máy chủ (NIC):** Liệt kê các card mạng vật lý Ethernet, Wi-Fi, VLAN, VPN... kèm IPv4, Netmask, CIDR và MAC.
- **Quét mạng thực tế (Live TCP Port & UDP SNMP Probe):**
  - Quét đồng thời các cổng quan trọng: `161` (SNMP UDP), `80/443` (Web Admin), `554/37777/8000` (Camera/NVR RTSP & SDK), `445/5000` (NAS SMB & Synology DSM), `22` (SSH Switch/Linux).
  - Tự động nhận diện thiết bị thông qua phản hồi SNMP `sysDescr` và chữ ký dịch vụ (Cisco, SonicWall, Fortinet, Dahua, Hikvision, Synology, Ubiquiti, APC...).
- **Chế độ quét linh hoạt:** Hỗ trợ cả **Quét Mạng Trực Tiếp (Live Scan)** và **Mô Phỏng Nhà Máy (Factory Demo Scan)**.
- **Thêm vào Topo 1-Click ("+ Thêm Vào Topo"):** Nạp thẳng thiết bị phát hiện vào sơ đồ mạng.

### 2. ⚡ Đo Lường SNMP Vật Lý 100% (Strict Real-Time)
- Gửi gói tin SNMP UDP Request OID nhị phân (ASN.1 BER Encoding) trực tiếp tới các thiết bị.
- Tính toán chính xác delta tốc độ truyền dữ liệu thực tế: `bps = ((octets_now - octets_prev) * 8) / deltaSec`.
- Tự động phát hiện thiết bị Offline (hiển thị trạng thái lỗi cảnh báo đỏ/vàng, băng thông 0 bps).

### 3. 🎨 Giao Diện Sơ Đồ Động & Kéo Thả (Interactive Cyberpunk Topo)
- **Kéo thả thiết bị tự do:** Bấm giữ chuột trái vào bất kỳ thiết bị nào để định vị lại vị trí trên sơ đồ. Tọa độ $(x, y)$ tự động lưu vĩnh viễn vào hệ thống.
- **Đường cáp Bezier uốn lượn:** Đường nối SVG co giãn mượt mà theo chuyển động thiết bị với hiệu ứng luồng hạt băng thông (Galaxy Flow / Dash Flow).
- **Phân nhóm phân xưởng (Zones):** Lọc và hiển thị theo từng khu vực: Phòng Server (MDF), Xưởng Cơ Khí, Xưởng Lắp Ráp, Kho Hàng, Văn Phòng...

### 4. 📹 Thông Số Chuyên Biệt Cho Đầu Ghi Camera (NVR)
- **Kênh ghi hình:** Tổng số kênh camera hỗ trợ và số kênh thực tế đang ghi hình.
- **Lưu trữ an ninh:** Dung lượng ổ cứng đã dùng/tổng TB, mục tiêu số ngày lưu trữ an ninh (retention days), chuẩn nén (H.265+, H.264...).

### 5. 🗄️ Thông Số Chuyên Biệt Cho Thiết Bị Lưu Trữ (NAS)
- **Dung lượng & Cấu hình RAID:** Dung lượng ổ cứng, RAID 5, RAID 6, RAID 10...
- **Bảng Thư Mục Chia Sẻ (Shared Folders):** Thêm / Sửa / Xóa trực tiếp thư mục chia sẻ mạng, dung lượng, phân quyền truy cập.
- **Bảng Tài Khoản Người Dùng (User Accounts):** Danh sách người dùng, phòng ban, vai trò và trạng thái hoạt động.

### 6. 🎛️ Bảng Điều Khiển Mặt Trước Phần Cứng Thực Tế Cho Mọi Thiết Bị (Hardware Faceplate Visualizer)
- **Hỗ trợ trực quan hóa toàn bộ thiết bị:** Nhấp vào bất kỳ node nào (Switch, Firewall, NAS, NVR, Server, AP, UPS) để mở bảng điều khiển phần cứng tương tự thiết bị thật.
- **Firewall Appliance:** Giao diện cổng `X0` - `X7`, đèn trạng thái động cơ Deep Packet Inspection (DPI), thống kê kênh VPN và Active Sessions.
- **NAS Storage Caddies:** Khay ổ đĩa có đèn LED truy xuất dữ liệu, cổng LAN 10G/1G, trạng thái mảng RAID.
- **NVR Camera Matrix:** Ma trận 64 đèn giám sát luồng hình ảnh camera thời gian thực, cổng LAN Camera và Client LAN.
- **Server & UPS LCD Bezel:** Màn hình LCD hiển thị điện áp, công suất tải, dung lượng pin và cổng quản trị NMC / iDRAC.
- **Tooltip Port HUD cố định siêu nét:** Hiển thị chi tiết trạng thái UP/DOWN, tốc độ kết nối, băng thông In/Out và công suất PoE với độ tương phản cao, định vị thông minh không che khuất cổng.

### 7. 🔍 Lựa Chọn Chỉ Số Giám Sát Cảm Biến Động (Dynamic SNMP Metric Discovery)
- Chỉ hiển thị các ô tùy chọn cảm biến (Ping, UpTime, CPU, RAM, Sức Khỏe/Nhiệt Độ, VPN, Sessions, Storage, PoE) mà thiết bị thực tế phản hồi qua SNMP.
- Không cố định danh sách cảm biến cứng nhắc—thiết bị Firewall không bị hiện PoE/Storage thừa thãi.
- Hỗ trợ chọn nhanh: *Chọn tất cả*, *Chỉ chỉ số cơ bản*, *Bỏ chọn tất cả*.

### 8. 📱 Cảnh Báo Tự Động Qua Telegram Bot
- Tùy chỉnh Bot Token, Chat ID trực tiếp trên Web.
- Tự động phát hiện và gửi tin nhắn cảnh báo khi thiết bị mất kết nối, nghẽn mạng hoặc tràn dung lượng ổ cứng.

---

## 🚀 HƯỚNG DẪN CÀI ĐẶT & CHẠY

Dự án hoàn toàn **không cần `npm install`**. Bạn chỉ cần cài [Node.js (LTS)](https://nodejs.org) là có thể chạy ngay!

### Cách 1: Chạy trên Windows
Nhấp đúp vào file:
👉 **`start.bat`**  
Hoặc mở PowerShell:
```powershell
node server.js
```

### Cách 2: Chạy trên Linux / macOS / Raspberry Pi
```bash
chmod +x start.sh
./start.sh
```

### Cách 3: Chạy bằng Docker
```bash
docker build -t factory-snmp .
docker run -d --restart always --net=host --name factory-snmp-app factory-snmp
```
*(Khuyến nghị cờ `--net=host` để container có thể quét IP và gửi gói tin SNMP trực tiếp vào dải mạng vật lý)*.

### Cách 4: Chạy 24/7 bằng PM2 (Khuyên dùng cho Server Nhà Máy)
```bash
npm install -g pm2
pm2 start server.js --name "factory-snmp"
pm2 save
pm2 startup
```

---

## 🌐 TRUY CẬP HỆ THỐNG

- **Trên máy chủ:** [http://localhost:3000](http://localhost:3000)
- **Từ máy khác trong mạng LAN:** `http://<IP_MÁY_CHỦ>:3000` (ví dụ: `http://192.168.10.106:3000`)

---

## 📂 CẤU TRÚC THƯ MỤC DỰ ÁN

```text
factory-snmp-monitor/
├── server.js               # Web Server + SNMP UDP Engine + TCP Port Scanner (Native Node.js)
├── package.json            # Thông tin dự án
├── start.bat               # File chạy nhanh 1-Click trên Windows
├── start.sh                # Script khởi động trên Linux / macOS
├── Dockerfile              # Dockerfile chạy ứng dụng trên container
├── config/
│   └── topology.json       # Cơ sở dữ liệu cấu hình thiết bị, tọa độ, phân xưởng, Telegram
└── public/
    ├── index.html          # Giao diện Dashboard chính (Cyberpunk Dark Mode)
    ├── css/
    │   └── style.css       # Toàn bộ CSS giao diện, menu dropdown, responsive
    └── js/
        └── app.js          # Logic tương tác Web, vẽ đường Topo SVG, SSE Live Stream
```

---

## 📄 GIẤY PHÉP

Dự án được phát hành theo giấy phép [MIT License](LICENSE).
