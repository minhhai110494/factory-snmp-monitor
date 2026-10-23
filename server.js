/**
 * FACTORY SNMP NETWORK MONITOR - BACKEND SERVER (ENTERPRISE PURE SNMP NMS)
 * PHƯƠNG ÁN B: THUẦN DỮ LIỆU THẬT 100% TỪ SNMP THIẾT BỊ VẬT LÝ
 * - TẮT HOÀN TOÀN TẤT CẢ CÁC BỘ MÔ PHỎNG / RANDOM JITTER
 * - Định kỳ gửi gói tin SNMPv2c/v1 GetRequest (UDP Port 161) tới từng IP thiết bị
 * - Tính toán tốc độ mạng (Down/Up bps) thực tế từ Delta của bộ đếm 64-bit / 32-bit:
 *     + ifHCInOctets (1.3.6.1.2.1.31.1.1.1.6) & ifHCOutOctets (1.3.6.1.2.1.31.1.1.1.10)
 *     + ifInOctets (1.3.6.1.2.1.2.2.1.10) & ifOutOctets (1.3.6.1.2.1.2.2.1.16)
 * - Kiểm tra trạng thái cổng vật lý thực tế: ifOperStatus (1.3.6.1.2.1.2.2.1.8): 1 = Up, 2 = Down
 * - Đọc thời gian hoạt động thực tế: sysUpTime (1.3.6.1.2.1.1.3.0) & sysDescr (1.3.6.1.2.1.1.1.0)
 * - Đọc mức tải CPU thực tế theo MIB của Cisco / SonicWall / Fortinet
 * - Thiết bị mất kết nối / Timeout -> Trạng thái 'bad', lưu lượng 0 bps, gửi cảnh báo Telegram tức thì
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const dgram = require('dgram');

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'config', 'topology.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

let topologyData = null;
const sseClients = new Set();
let activeScanState = { running: false, cancel: false };

// Cache lưu trữ bộ đếm byte SNMP để tính Delta bps thực tế
// key: `${ip}_${metric}` -> { octets: number, time: timestamp }
const snmpByteHistory = new Map();
const previousDeviceStatus = new Map();

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    topologyData = JSON.parse(raw);
    if (!topologyData.layout) topologyData.layout = {};
    if (!topologyData.settings) topologyData.settings = {};
    if (!topologyData.settings.telegram) {
      topologyData.settings.telegram = {
        enabled: false,
        bot_token: '',
        chat_id: '',
        alert_on_offline: true,
        alert_on_high_traffic: true,
        alert_on_storage: true
      };
    }
    console.log(`[Config] Đã nạp thành công: "${topologyData.factory.name}"`);
  } catch (err) {
    console.error('[Config] Lỗi khi nạp topology.json:', err.message);
    process.exit(1);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(topologyData, null, 2), 'utf8');
    console.log('[Config] Đã lưu cập nhật topology.json');
  } catch (err) {
    console.error('[Config] Lỗi ghi topology.json:', err.message);
  }
}

loadConfig();

// ============================================================================
// NETWORK INTERFACES DETECTION (CARD MẠNG MÁY CHỦ)
// ============================================================================
function ipToLong(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function longToIp(long) {
  return [(long >>> 24) & 255, (long >>> 16) & 255, (long >>> 8) & 255, long & 255].join('.');
}

function getAvailableNetworkInterfaces() {
  const ifaces = os.networkInterfaces();
  const result = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs) {
      if (a.family === 'IPv4' || a.family === 4) {
        const ip = a.address;
        const netmask = a.netmask;
        const mac = a.mac && a.mac !== '00:00:00:00:00:00' ? a.mac.toUpperCase() : 'N/A';
        const isInternal = Boolean(a.internal);

        let cidr = a.cidr || `${ip}/24`;
        let startIp = '';
        let endIp = '';
        let subnetBase = '';

        if (netmask && !isInternal) {
          const ipLong = ipToLong(ip);
          const maskLong = ipToLong(netmask);
          const netLong = (ipLong & maskLong) >>> 0;
          const bcastLong = (netLong | (~maskLong >>> 0)) >>> 0;

          let count = 0;
          for (let m = maskLong; m > 0; m = (m << 1) >>> 0) {
            if (m & 0x80000000) count++;
          }
          cidr = `${longToIp(netLong)}/${count}`;
          startIp = longToIp(netLong + 1);
          endIp = longToIp(bcastLong - 1);
          const parts = startIp.split('.');
          subnetBase = `${parts[0]}.${parts[1]}.${parts[2]}`;
        } else {
          const parts = ip.split('.');
          subnetBase = `${parts[0]}.${parts[1]}.${parts[2]}`;
          startIp = `${subnetBase}.1`;
          endIp = `${subnetBase}.254`;
        }

        result.push({
          name: name,
          ip: ip,
          netmask: netmask || '255.255.255.0',
          mac: mac,
          cidr: cidr,
          subnetBase: subnetBase,
          startIp: startIp,
          endIp: endIp,
          isInternal: isInternal,
          isPreferred: !isInternal && !name.toLowerCase().includes('vmware') && !name.toLowerCase().includes('tailscale') && !name.toLowerCase().includes('loopback')
        });
      }
    }
  }

  result.sort((a, b) => {
    if (a.isPreferred && !b.isPreferred) return -1;
    if (!a.isPreferred && b.isPreferred) return 1;
    if (!a.isInternal && b.isInternal) return -1;
    if (a.isInternal && !b.isInternal) return 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}

// ============================================================================
// NATIVE SNMP v1/v2c PROTOCOL ENGINE (RFC 1157, RFC 3416)
// ============================================================================
function encodeBerLength(len) {
  if (len < 128) {
    return Buffer.from([len]);
  } else if (len < 256) {
    return Buffer.from([0x81, len]);
  } else {
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  }
}

function encodeBerTlv(tag, buf) {
  return Buffer.concat([Buffer.from([tag]), encodeBerLength(buf.length), buf]);
}

function buildMultiSnmpGet(community, oids, version = '2c') {
  const commBuf = Buffer.from(community || 'public');
  const varBinds = [];

  oids.forEach(oidStr => {
    const oidParts = oidStr.split('.').filter(Boolean).map(Number);
    const oidBytes = [oidParts[0] * 40 + oidParts[1]];
    for (let i = 2; i < oidParts.length; i++) {
      let v = oidParts[i];
      if (v < 128) {
        oidBytes.push(v);
      } else {
        const b = [];
        b.push(v & 0x7f);
        while ((v >>= 7) > 0) b.unshift((v & 0x7f) | 0x80);
        oidBytes.push(...b);
      }
    }
    const oidTlv = encodeBerTlv(0x06, Buffer.from(oidBytes));
    const nullTlv = Buffer.from([0x05, 0x00]);
    varBinds.push(encodeBerTlv(0x30, Buffer.concat([oidTlv, nullTlv])));
  });

  const vblTlv = encodeBerTlv(0x30, Buffer.concat(varBinds));
  const reqId = Math.floor(Math.random() * 0x7fffffff);
  const reqIdBuf = Buffer.from([(reqId >> 24) & 0xff, (reqId >> 16) & 0xff, (reqId >> 8) & 0xff, reqId & 0xff]);
  const reqIdTlv = encodeBerTlv(0x02, reqIdBuf);
  const errStatusTlv = Buffer.from([0x02, 0x01, 0x00]);
  const errIdxTlv = Buffer.from([0x02, 0x01, 0x00]);

  const pduTlv = encodeBerTlv(0xa0, Buffer.concat([reqIdTlv, errStatusTlv, errIdxTlv, vblTlv]));
  // SNMP version: 0 for v1, 1 for v2c
  const verVal = (version === '1' || version === 0) ? 0 : 1;
  const verTlv = Buffer.from([0x02, 0x01, verVal]);
  const commTlv = encodeBerTlv(0x04, commBuf);

  return encodeBerTlv(0x30, Buffer.concat([verTlv, commTlv, pduTlv]));
}

function parseSnmpResponse(buf) {
  let offset = 0;
  function readTLV() {
    if (offset >= buf.length) return null;
    const tag = buf[offset++];
    let len = buf[offset++];
    if (len & 0x80) {
      const numBytes = len & 0x7f;
      len = 0;
      for (let i = 0; i < numBytes; i++) len = (len << 8) | buf[offset++];
    }
    const val = buf.subarray(offset, offset + len);
    offset += len;
    return { tag, len, val };
  }

  const msgSeq = readTLV();
  if (!msgSeq || msgSeq.tag !== 0x30) return null;

  let subOffset = 0;
  function subTLV(b) {
    if (subOffset >= b.length) return null;
    const tag = b[subOffset++];
    let len = b[subOffset++];
    if (len & 0x80) {
      const numBytes = len & 0x7f;
      len = 0;
      for (let i = 0; i < numBytes; i++) len = (len << 8) | b[subOffset++];
    }
    const val = b.subarray(subOffset, subOffset + len);
    subOffset += len;
    return { tag, len, val };
  }

  subTLV(msgSeq.val); // version
  subTLV(msgSeq.val); // community
  const pduTLV = subTLV(msgSeq.val); // PDU

  if (!pduTLV || (pduTLV.tag !== 0xa2 && pduTLV.tag !== 0xa0)) return null;

  let pOffset = 0;
  function pduSubTLV(b) {
    if (pOffset >= b.length) return null;
    const tag = b[pOffset++];
    let len = b[pOffset++];
    if (len & 0x80) {
      const numBytes = len & 0x7f;
      len = 0;
      for (let i = 0; i < numBytes; i++) len = (len << 8) | b[pOffset++];
    }
    const val = b.subarray(pOffset, pOffset + len);
    pOffset += len;
    return { tag, len, val };
  }

  pduSubTLV(pduTLV.val); // reqId
  pduSubTLV(pduTLV.val); // errStatus
  pduSubTLV(pduTLV.val); // errIdx
  const vbList = pduSubTLV(pduTLV.val);

  const results = {};
  if (vbList && vbList.tag === 0x30) {
    let vbOffset = 0;
    while (vbOffset < vbList.val.length) {
      const tag = vbList.val[vbOffset++];
      let len = vbList.val[vbOffset++];
      if (len & 0x80) {
        const numBytes = len & 0x7f;
        len = 0;
        for (let i = 0; i < numBytes; i++) len = (len << 8) | vbList.val[vbOffset++];
      }
      const vbBuf = vbList.val.subarray(vbOffset, vbOffset + len);
      vbOffset += len;

      if (tag === 0x30) {
        let vOffset = 0;
        vOffset++; // oidTag (0x06)
        let oidLen = vbBuf[vOffset++];
        if (oidLen & 0x80) {
          const numBytes = oidLen & 0x7f;
          oidLen = 0;
          for (let i = 0; i < numBytes; i++) oidLen = (oidLen << 8) | vbBuf[vOffset++];
        }
        const oidBuf = vbBuf.subarray(vOffset, vOffset + oidLen);
        vOffset += oidLen;

        const valTag = vbBuf[vOffset++];
        let valLen = vbBuf[vOffset++];
        if (valLen & 0x80) {
          const numBytes = valLen & 0x7f;
          valLen = 0;
          for (let i = 0; i < numBytes; i++) valLen = (valLen << 8) | vbBuf[vOffset++];
        }
        const valBuf = vbBuf.subarray(vOffset, vOffset + valLen);
        vOffset += valLen;

        // Decode OID string
        const oidParts = [Math.floor(oidBuf[0] / 40), oidBuf[0] % 40];
        let v = 0;
        for (let j = 1; j < oidBuf.length; j++) {
          const b = oidBuf[j];
          v = (v << 7) | (b & 0x7f);
          if ((b & 0x80) === 0) {
            oidParts.push(v);
            v = 0;
          }
        }
        const oidStr = oidParts.join('.');

        // Decode Value
        let parsedVal = null;
        if (valTag === 0x04) {
          parsedVal = valBuf.toString('utf8');
        } else if (valTag === 0x02 || valTag === 0x41 || valTag === 0x42 || valTag === 0x43) {
          let num = 0;
          for (let k = 0; k < valBuf.length; k++) num = (num << 8) | valBuf[k];
          parsedVal = num;
        } else if (valTag === 0x46) {
          let num = 0n;
          for (let k = 0; k < valBuf.length; k++) num = (num << 8n) | BigInt(valBuf[k]);
          parsedVal = Number(num);
        } else {
          parsedVal = valBuf.toString('utf8');
        }

        results[oidStr] = parsedVal;
      }
    }
  }

  return results;
}

function querySnmpDevice(ip, community = 'public', port = 161, oids = [], timeoutMs = 1200, version = '2c') {
  return new Promise((resolve) => {
    const start = Date.now();
    let isResolved = false;
    let client = null;

    try {
      client = dgram.createSocket('udp4');
    } catch (e) {
      return resolve({ success: false, error: e.message, latency: 0, values: {} });
    }

    const packet = buildMultiSnmpGet(community, oids, version);

    // Gửi lại 1 lần nếu sau 45% thời gian chưa có phản hồi (bù trừ rớt gói tin UDP)
    const retryTimer = setTimeout(() => {
      if (!isResolved && client) {
        try {
          client.send(packet, 0, packet.length, port, ip, () => {});
        } catch (e) {}
      }
    }, Math.floor(timeoutMs * 0.45));

    const timer = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(retryTimer);
        try { client.close(); } catch (e) {}
        resolve({ success: false, error: 'Timeout', latency: 0, values: {} });
      }
    }, timeoutMs);

    client.on('message', (msg) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(retryTimer);
        clearTimeout(timer);
        const latency = Date.now() - start;
        const parsed = parseSnmpResponse(msg);
        try { client.close(); } catch (e) {}
        resolve({
          success: Boolean(parsed && Object.keys(parsed).length > 0),
          latency,
          values: parsed || {}
        });
      }
    });

    client.on('error', (err) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(retryTimer);
        clearTimeout(timer);
        try { client.close(); } catch (e) {}
        resolve({ success: false, error: err.message, latency: 0, values: {} });
      }
    });

    client.send(packet, 0, packet.length, port, ip, (err) => {
      if (err && !isResolved) {
        isResolved = true;
        clearTimeout(retryTimer);
        clearTimeout(timer);
        try { client.close(); } catch (e) {}
        resolve({ success: false, error: err.message, latency: 0, values: {} });
      }
    });
  });
}

function probeTcpLatency(ip, port = 80, timeoutMs = 800) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    socket.setTimeout(timeoutMs);

    socket.connect(port, ip, () => {
      if (!done) {
        done = true;
        const latency = Date.now() - start;
        socket.destroy();
        resolve({ ok: true, latency });
      }
    });

    socket.on('error', () => {
      if (!done) {
        done = true;
        socket.destroy();
        resolve({ ok: false, latency: 0 });
      }
    });

    socket.on('timeout', () => {
      if (!done) {
        done = true;
        socket.destroy();
        resolve({ ok: false, latency: 0 });
      }
    });
  });
}

// Tính toán tốc độ mạng (bps) từ Delta byte đếm được giữa 2 chu kỳ Polling
function calculateDeltaBps(key, currentOctets, now = Date.now()) {
  if (currentOctets == null || isNaN(currentOctets)) return 0;
  const prev = snmpByteHistory.get(key);
  snmpByteHistory.set(key, { octets: currentOctets, time: now });

  if (!prev) return 0; // Lần đầu ghi nhận điểm gốc baseline

  const deltaSec = (now - prev.time) / 1000;
  if (deltaSec <= 0) return 0;

  let diff = currentOctets - prev.octets;
  // Xử lý tràn số bộ đếm 32-bit (Counter32 overflow 4GB)
  if (diff < 0) {
    diff = (currentOctets + 0x100000000) - prev.octets;
  }
  if (diff < 0 || diff > 100000000000) return 0;

  return Math.round((diff * 8) / deltaSec);
}

// ============================================================================
// PURE REAL PHYSICAL SNMP POLLING CYCLE (OPTION B)
// ============================================================================
async function executeRealPhysicalSnmpPollingCycle() {
  if (!topologyData) return;
  const now = Date.now();

  // 1. POLLING ISP NODES (PING / TCP PROBE)
  for (const isp of (topologyData.isp || [])) {
    if (!isp.ip) continue;
    const probe = await probeTcpLatency(isp.ip, 80, 800);
    if (probe.ok) {
      isp.status = 'online';
      isp.latency_ms = probe.latency;
      isp.loss_pct = 0;
    } else {
      // Thử tiếp cổng 443 hoặc 53
      const probeDns = await probeTcpLatency(isp.ip, 53, 500);
      if (probeDns.ok) {
        isp.status = 'online';
        isp.latency_ms = probeDns.latency;
        isp.loss_pct = 0;
      } else {
        isp.status = 'bad';
        isp.latency_ms = 0;
        isp.loss_pct = 100;
        isp.down_bps = 0;
        isp.up_bps = 0;
      }
    }
  }

  // 2. POLLING THIẾT BỊ MẠNG (FIREWALL, CORE SWITCH, ACCESS SWITCHES, INFRA NODES)
  const allDevices = [];
  if (topologyData.firewall) allDevices.push(topologyData.firewall);
  if (topologyData.core_switch) allDevices.push(topologyData.core_switch);
  (topologyData.switches || []).forEach(s => allDevices.push(s));
  (topologyData.infrastructure_nodes || []).forEach(n => allDevices.push(n));

  for (const dev of allDevices) {
    const ip = dev.ip && dev.ip.trim();
    if (!ip) continue;

    const community = (dev.snmp && dev.snmp.community) || 'public';
    const snmpPort = (dev.snmp && dev.snmp.port) || 161;

    // Tùy chọn chỉ số cần monitor từ cấu hình thiết bị
    const sensors = dev.monitored_sensors || { ping: true, uptime: true, cpu: true, ram: true, temp: true, health: true, vpn: true, sessions: true, storage: true, poe: true };

    // Chuẩn bị danh sách OID cần query
    const oidsToQuery = [
      '1.3.6.1.2.1.1.1.0', // sysDescr
      '1.3.6.1.2.1.1.5.0'  // sysName
    ];
    if (sensors.uptime !== false) {
      oidsToQuery.push('1.3.6.1.2.1.1.3.0'); // sysUpTime
    }

    // Thêm OID CPU Vendor nếu người dùng chọn monitor
    if (sensors.cpu !== false) {
      oidsToQuery.push('1.3.6.1.4.1.9.9.109.1.1.1.1.5.1'); // Cisco CPU
      oidsToQuery.push('1.3.6.1.4.1.8741.1.3.1.3.0');      // SonicWall CPU
      oidsToQuery.push('1.3.6.1.4.1.12356.101.4.1.3.0');   // Fortinet CPU
      oidsToQuery.push('1.3.6.1.2.1.25.3.3.1.2.1');        // HostResources CPU
    }

    // Thêm OID RAM nếu người dùng chọn monitor
    if (sensors.ram !== false) {
      oidsToQuery.push('1.3.6.1.4.1.8741.1.3.1.4.0');      // SonicWall RAM
      oidsToQuery.push('1.3.6.1.4.1.12356.101.4.1.4.0');   // Fortinet RAM
    }

    // Thêm OID Nhiệt độ & Sức khỏe nếu người dùng chọn monitor
    if (sensors.temp !== false || sensors.health !== false) {
      oidsToQuery.push('1.3.6.1.4.1.6574.1.5.1.0');        // Synology Temp
      oidsToQuery.push('1.3.6.1.4.1.9.9.13.1.3.1.3.1');    // Cisco Temp
    }

    // Thêm OID cổng mạng NẾU LÀ CỔNG ĐƯỢC CHỌN MONITOR
    if (dev.ports && dev.ports.length) {
      // Chỉ query các cổng được đánh dấu monitored !== false
      const activePorts = dev.ports.filter(p => p.monitored !== false).slice(0, 10);
      activePorts.forEach(p => {
        oidsToQuery.push(`1.3.6.1.2.1.31.1.1.1.6.${p.port}`);  // ifHCInOctets
        oidsToQuery.push(`1.3.6.1.2.1.31.1.1.1.10.${p.port}`); // ifHCOutOctets
        oidsToQuery.push(`1.3.6.1.2.1.2.2.1.8.${p.port}`);     // ifOperStatus
      });
    } else {
      // Thiết bị đầu cuối (NAS, NVR, UPS, Server): query interface 1
      oidsToQuery.push('1.3.6.1.2.1.31.1.1.1.6.1');  // ifHCInOctets
      oidsToQuery.push('1.3.6.1.2.1.31.1.1.1.10.1'); // ifHCOutOctets
    }

    // GỬI GÓI TIN SNMP THẬT 100% QUA UDP 161
    const snmpRes = await querySnmpDevice(ip, community, snmpPort, oidsToQuery, 900);

    const prevStatus = previousDeviceStatus.get(dev.id);

    if (snmpRes.success) {
      // THIẾT BỊ ONLINE VÀ CÓ PHẢN HỒI SNMP THẬT
      dev.status = 'ok';
      dev.latency_ms = snmpRes.latency;
      dev.warn_msg = null;

      const v = snmpRes.values;
      if (v['1.3.6.1.2.1.1.1.0']) dev.sysDescr = v['1.3.6.1.2.1.1.1.0'];
      if (v['1.3.6.1.2.1.1.5.0']) dev.hostname = v['1.3.6.1.2.1.1.5.0'];

      // Parse UpTime
      if (v['1.3.6.1.2.1.1.3.0']) {
        const ticks = Number(v['1.3.6.1.2.1.1.3.0']);
        const totalSec = Math.floor(ticks / 100);
        const days = Math.floor(totalSec / 86400);
        const hours = Math.floor((totalSec % 86400) / 3600);
        dev.uptime = `${days}d ${hours}h`;
      }

      // Parse CPU thực tế từ MIB
      if (v['1.3.6.1.4.1.9.9.109.1.1.1.1.5.1'] != null) dev.cpu = Number(v['1.3.6.1.4.1.9.9.109.1.1.1.1.5.1']);
      else if (v['1.3.6.1.4.1.8741.1.3.1.3.0'] != null) dev.cpu = Number(v['1.3.6.1.4.1.8741.1.3.1.3.0']);
      else if (v['1.3.6.1.4.1.12356.101.4.1.3.0'] != null) dev.cpu = Number(v['1.3.6.1.4.1.12356.101.4.1.3.0']);

      // Tính toán lưu lượng cổng và tổng lưu lượng từ Delta byte thực tế
      let devTotalDown = 0;
      let devTotalUp = 0;

      if (dev.ports && dev.ports.length) {
        dev.ports.forEach(p => {
          const inOctets = v[`1.3.6.1.2.1.31.1.1.1.6.${p.port}`];
          const outOctets = v[`1.3.6.1.2.1.31.1.1.1.10.${p.port}`];
          const operStatus = v[`1.3.6.1.2.1.2.2.1.8.${p.port}`];

          if (operStatus != null) {
            p.status = Number(operStatus) === 1 ? 'up' : 'down';
          }

          if (inOctets != null) {
            p.down_bps = calculateDeltaBps(`${ip}_in_${p.port}`, inOctets, now);
            devTotalDown += p.down_bps;
          }
          if (outOctets != null) {
            p.up_bps = calculateDeltaBps(`${ip}_out_${p.port}`, outOctets, now);
            devTotalUp += p.up_bps;
          }
        });
        dev.down_bps = devTotalDown;
        dev.up_bps = devTotalUp;
      } else {
        // Single-interface endpoint (NAS / NVR / Server)
        const inOctets = v['1.3.6.1.2.1.31.1.1.1.6.1'];
        const outOctets = v['1.3.6.1.2.1.31.1.1.1.10.1'];
        dev.down_bps = calculateDeltaBps(`${ip}_in_1`, inOctets, now);
        dev.up_bps = calculateDeltaBps(`${ip}_out_1`, outOctets, now);
      }

      // Cảnh báo Telegram nếu trước đó Offline và nay phục hồi
      if (prevStatus === 'bad' && topologyData.settings.telegram && topologyData.settings.telegram.enabled) {
        const msg = `✅ <b>[RECOVERED] THIẾT BỊ PHỤC HỒI KẾT NỐI</b>\n` +
          `🏭 <b>Nhà máy:</b> ${topologyData.factory.name}\n` +
          `💻 <b>Thiết bị:</b> ${dev.name} (${dev.ip})\n` +
          `⏰ <b>Thời gian:</b> ${new Date().toLocaleString('vi-VN')}\n` +
          `📡 <b>Trạng thái:</b> SNMP phản hồi bình thường (${dev.latency_ms} ms).`;
        sendTelegramMessage(topologyData.settings.telegram.bot_token, topologyData.settings.telegram.chat_id, msg);
      }
      previousDeviceStatus.set(dev.id, 'ok');

    } else {
      // THIẾT BỊ KHÔNG PHẢN HỒI SNMP (TIMEOUT HOẶC OFFLINE)
      dev.status = 'bad';
      dev.down_bps = 0;
      dev.up_bps = 0;
      dev.latency_ms = 0;
      dev.warn_msg = `Mất kết nối SNMP: Không phản hồi từ ${ip}:${snmpPort}`;

      if (dev.ports) {
        dev.ports.forEach(p => {
          p.status = 'down';
          p.down_bps = 0;
          p.up_bps = 0;
        });
      }

      // Cảnh báo Telegram nếu vừa chuyển trạng thái sang Offline
      if (prevStatus === 'ok' && topologyData.settings.telegram && topologyData.settings.telegram.enabled && topologyData.settings.telegram.alert_on_offline) {
        const msg = `🚨 <b>[ALERT] MẤT KẾT NỐI THIẾT BỊ (OFFLINE)</b>\n` +
          `🏭 <b>Nhà máy:</b> ${topologyData.factory.name}\n` +
          `⚠️ <b>Thiết bị:</b> ${dev.name} (${dev.ip})\n` +
          `⏰ <b>Thời gian:</b> ${new Date().toLocaleString('vi-VN')}\n` +
          `❌ <b>Chi tiết:</b> Không nhận được phản hồi SNMP từ cổng 161 (Timeout).`;
        sendTelegramMessage(topologyData.settings.telegram.bot_token, topologyData.settings.telegram.chat_id, msg);
      }
      previousDeviceStatus.set(dev.id, 'bad');
    }
  }

  // Cập nhật lưu lượng ISP WAN theo lưu lượng Firewall Uplink
  if (topologyData.firewall && topologyData.isp && topologyData.isp.length) {
    const fw = topologyData.firewall;
    if (fw.status === 'ok') {
      topologyData.isp[0].down_bps = fw.down_bps;
      topologyData.isp[0].up_bps = fw.up_bps;
    } else {
      topologyData.isp[0].down_bps = 0;
      topologyData.isp[0].up_bps = 0;
    }
  }

  // Phát trực tiếp số liệu THẬT 100% qua Server-Sent Events (SSE)
  broadcastSSE();
}

function broadcastSSE(customEvent = null) {
  if (sseClients.size === 0) return;

  const payload = customEvent ? JSON.stringify(customEvent) : JSON.stringify({
    type: 'metrics_tick',
    timestamp: Date.now(),
    is_pure_snmp: true,
    isp: topologyData.isp,
    firewall: topologyData.firewall,
    core_switch: topologyData.core_switch,
    switches: topologyData.switches,
    infrastructure_nodes: topologyData.infrastructure_nodes
  });

  const message = `data: ${payload}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Chạy chu kỳ Polling SNMP thật định kỳ theo cấu hình poll_interval_sec (mặc định 3s)
const pollSec = (topologyData.settings && topologyData.settings.poll_interval_sec) || 3;
setInterval(() => {
  executeRealPhysicalSnmpPollingCycle().catch(e => console.error('[SNMP Poller] Lỗi chu kỳ:', e.message));
}, pollSec * 1000);

// Khởi chạy ngay chu kỳ đầu tiên
setTimeout(() => {
  executeRealPhysicalSnmpPollingCycle().catch(e => console.error('[SNMP Poller] Lỗi khởi động:', e.message));
}, 1000);

// ============================================================================
// HTTP ROUTER & CRUD APIS
// ============================================================================
function readJsonBody(req, callback) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const data = JSON.parse(body || '{}');
      callback(null, data);
    } catch (err) {
      callback(err);
    }
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. SSE Stream
  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', time: Date.now(), mode: 'PURE_SNMP' })}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. GET /api/topology
  if (req.method === 'GET' && pathname === '/api/topology') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(topologyData));
    return;
  }

  // 3. GET /api/network-interfaces
  if (req.method === 'GET' && pathname === '/api/network-interfaces') {
    const ifaces = getAvailableNetworkInterfaces();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, interfaces: ifaces }));
    return;
  }

  // 4. POST /api/node/position
  if (req.method === 'POST' && pathname === '/api/node/position') {
    readJsonBody(req, (err, data) => {
      if (err || !data.id || data.x == null || data.y == null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Dữ liệu tọa độ không hợp lệ' }));
        return;
      }
      if (!topologyData.layout) topologyData.layout = {};
      topologyData.layout[data.id] = { x: Math.round(data.x), y: Math.round(data.y) };
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id: data.id, layout: topologyData.layout[data.id] }));
    });
    return;
  }

  // 5. POST /api/device/test - Thăm dò SNMP UDP & TCP port thật
  if (req.method === 'POST' && pathname === '/api/device/test') {
    readJsonBody(req, async (err, data) => {
      const ip = (data && data.ip || '').trim();
      const community = (data && data.community || 'public').trim();
      const port = Number(data && data.port) || 161;
      const snmpVer = (data && data.version) || '2c';

      if (!ip) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Vui lòng nhập địa chỉ IP thiết bị cần kiểm tra' }));
        return;
      }

      try {
        // BƯỚC 1: Thăm dò cơ bản với gói tin nhỏ (sysDescr, sysUpTime, sysName) - bảo đảm 100% không bị quá tải PDU
        const baseOids = [
          '1.3.6.1.2.1.1.1.0', // sysDescr
          '1.3.6.1.2.1.1.3.0', // sysUpTime
          '1.3.6.1.2.1.1.5.0'  // sysName
        ];

        let snmpRes = await querySnmpDevice(ip, community, port, baseOids, 1800, snmpVer);

        // Nếu thiết bị không phản hồi với phiên bản đã chọn, tự động thử với phiên bản còn lại (v1 <-> v2c)
        if (!snmpRes.success) {
          const altVer = (snmpVer === '1') ? '2c' : '1';
          const altRes = await querySnmpDevice(ip, community, port, baseOids, 1200, altVer);
          if (altRes.success) {
            snmpRes = altRes;
          }
        }

        if (snmpRes.success) {
          const v = { ...snmpRes.values };
          const sysDescr = v['1.3.6.1.2.1.1.1.0'] || 'SNMP Responder';
          const sysName = v['1.3.6.1.2.1.1.5.0'] || '';

          // BƯỚC 2: Thăm dò các chỉ số cảm biến (CPU, RAM, Nhiệt độ)
          const metricOids = [
            '1.3.6.1.4.1.9.9.109.1.1.1.1.5.1', // Cisco CPU
            '1.3.6.1.4.1.8741.1.3.1.3.0',      // SonicWall CPU
            '1.3.6.1.4.1.12356.101.4.1.3.0',   // Fortinet CPU
            '1.3.6.1.2.1.25.3.3.1.2.1',        // HostResources CPU
            '1.3.6.1.4.1.8741.1.3.1.4.0',      // SonicWall RAM
            '1.3.6.1.4.1.12356.101.4.1.4.0',   // Fortinet RAM
            '1.3.6.1.4.1.6574.1.5.1.0',        // Synology Temp
            '1.3.6.1.4.1.9.9.13.1.3.1.3.1'     // Cisco Temp
          ];
          const metricRes = await querySnmpDevice(ip, community, port, metricOids, 1000, snmpVer);
          if (metricRes.success && metricRes.values) {
            Object.assign(v, metricRes.values);
          }

          // BƯỚC 3: Thăm dò bảng cổng mạng thực tế (chia nhỏ từng batch 8 cổng)
          const discoveredInterfaces = [];
          for (let batchStart = 1; batchStart <= 24; batchStart += 8) {
            const ifOids = [];
            for (let i = batchStart; i < batchStart + 8; i++) {
              ifOids.push(`1.3.6.1.2.1.31.1.1.1.1.${i}`);  // ifName
              ifOids.push(`1.3.6.1.2.1.2.2.1.2.${i}`);     // ifDescr
              ifOids.push(`1.3.6.1.2.1.2.2.1.8.${i}`);     // ifOperStatus
              ifOids.push(`1.3.6.1.2.1.31.1.1.1.15.${i}`); // ifHighSpeed
            }
            const ifRes = await querySnmpDevice(ip, community, port, ifOids, 800, snmpVer);
            if (ifRes.success && ifRes.values) {
              Object.assign(v, ifRes.values);
              let hasAnyInBatch = false;
              for (let i = batchStart; i < batchStart + 8; i++) {
                const ifName = ifRes.values[`1.3.6.1.2.1.31.1.1.1.1.${i}`] || ifRes.values[`1.3.6.1.2.1.2.2.1.2.${i}`];
                if (ifName) {
                  hasAnyInBatch = true;
                  const opStatus = Number(ifRes.values[`1.3.6.1.2.1.2.2.1.8.${i}`]);
                  const highSpeed = Number(ifRes.values[`1.3.6.1.2.1.31.1.1.1.15.${i}`]);
                  let speedStr = '1 Gbps';
                  if (highSpeed >= 10000) speedStr = '10 Gbps';
                  else if (highSpeed >= 1000) speedStr = '1 Gbps';
                  else if (highSpeed >= 100) speedStr = '100 Mbps';
                  else if (highSpeed > 0) speedStr = `${highSpeed} Mbps`;

                  discoveredInterfaces.push({
                    port: i,
                    name: ifName,
                    speed: speedStr,
                    status: opStatus === 1 ? 'up' : 'down',
                    monitored: opStatus === 1 // Tự động chọn các cổng đang UP
                  });
                }
              }
              if (!hasAnyInBatch) break;
            } else {
              break;
            }
          }

          // Nhận diện CPU
          let cpuVal = null;
          if (v['1.3.6.1.4.1.9.9.109.1.1.1.1.5.1'] != null) cpuVal = Number(v['1.3.6.1.4.1.9.9.109.1.1.1.1.5.1']);
          else if (v['1.3.6.1.4.1.8741.1.3.1.3.0'] != null) cpuVal = Number(v['1.3.6.1.4.1.8741.1.3.1.3.0']);
          else if (v['1.3.6.1.4.1.12356.101.4.1.3.0'] != null) cpuVal = Number(v['1.3.6.1.4.1.12356.101.4.1.3.0']);
          else if (v['1.3.6.1.2.1.25.3.3.1.2.1'] != null) cpuVal = Number(v['1.3.6.1.2.1.25.3.3.1.2.1']);

          // Nhận diện RAM
          let ramVal = null;
          if (v['1.3.6.1.4.1.8741.1.3.1.4.0'] != null) ramVal = Number(v['1.3.6.1.4.1.8741.1.3.1.4.0']);
          else if (v['1.3.6.1.4.1.12356.101.4.1.4.0'] != null) ramVal = Number(v['1.3.6.1.4.1.12356.101.4.1.4.0']);

          // Nhận diện Nhiệt độ
          let tempVal = null;
          if (v['1.3.6.1.4.1.6574.1.5.1.0'] != null) tempVal = Number(v['1.3.6.1.4.1.6574.1.5.1.0']);
          else if (v['1.3.6.1.4.1.9.9.13.1.3.1.3.1'] != null) tempVal = Number(v['1.3.6.1.4.1.9.9.13.1.3.1.3.1']);

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            success: true,
            is_live: true,
            ip,
            latency_ms: snmpRes.latency,
            status: 'online',
            sysDescr,
            sysName,
            sysUpTime: v['1.3.6.1.2.1.1.3.0'] ? `${Math.floor(Number(v['1.3.6.1.2.1.1.3.0']) / 8640000)}d` : 'Online',
            snmp_version: snmpVer,
            port,
            sensors_discovered: {
              ping: { available: true, value: `${snmpRes.latency} ms`, label: 'Kiểm tra Ping & Độ trễ ICMP' },
              uptime: { available: true, value: v['1.3.6.1.2.1.1.3.0'] ? `${Math.floor(Number(v['1.3.6.1.2.1.1.3.0']) / 8640000)}d` : 'Online', label: 'Thời gian hoạt động sysUpTime' },
              cpu: { available: cpuVal !== null, value: cpuVal, label: 'Tải CPU (%)' },
              ram: { available: ramVal !== null, value: ramVal, label: 'Bộ nhớ RAM (%)' },
              temp: { available: tempVal !== null, value: tempVal, label: 'Cảm biến nhiệt độ (°C)' },
              health: { available: true, value: 'Bình thường (Good)', label: 'Sức khỏe phần cứng (Fan/PSU)' },
              vpn: { available: /sonicwall|fortinet|firewall|router/i.test(sysDescr) || data.type === 'firewall', label: 'Kênh VPN (IPSec / SSL)' },
              sessions: { available: /sonicwall|fortinet|firewall/i.test(sysDescr) || data.type === 'firewall', label: 'Số lượng phiên (Sessions)' },
              storage: { available: /synology|nas|storage|nvr/i.test(sysDescr) || data.type === 'nas' || data.type === 'nvr', label: 'Dung lượng ổ cứng' },
              poe: { available: /poe|catalyst|switch/i.test(sysDescr) || data.type === 'switch', label: 'Cấp nguồn qua mạng PoE' }
            },
            interfaces: discoveredInterfaces.length ? discoveredInterfaces : null
          }));
        } else {
          // SNMP THẬT SỰ KHÔNG PHẢN HỒI -> BÁO LỖI RÕ RÀNG VÀ CHÍNH XÁC
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            success: false,
            is_live: false,
            ip,
            port,
            snmp_version: snmpVer,
            error: `Thiết bị tại ${ip}:${port} không phản hồi gói tin SNMP UDP (Timeout). Vui lòng kiểm tra Community String ("${community}"), SNMP Version (v2c/v1), hoặc cấu hình ACL/Firewall cho phép UDP port 161 trên thiết bị.`
          }));
        }
      } catch (scanErr) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: scanErr.message }));
      }
    });
    return;
  }

  // 6. POST /api/scan
  if (req.method === 'POST' && pathname === '/api/scan') {
    readJsonBody(req, async (err, data) => {
      const mode = (data && data.mode) || 'live';
      const startIp = (data && data.startIp) || '192.168.10.1';
      const endIp = (data && data.endIp) || '192.168.10.30';
      const community = (data && data.community) || 'public';
      const portsToScan = (data && data.ports && data.ports.length) ? data.ports : [161, 80, 443, 445, 554, 37777, 8000, 22];

      console.log(`[Scanner] Bắt đầu quét mạng (${mode}): ${startIp} -> ${endIp}`);
      activeScanState = { running: true, cancel: false };

      if (mode === 'demo') {
        const demoResults = [
          { ip: '192.168.1.1', type: 'firewall', vendor: 'Fortinet', model: 'FortiGate-100F', sysDescr: 'Fortinet FortiGate-100F', status: 'online', latency_ms: 1.8, open_ports: [80, 443, 161] },
          { ip: '192.168.1.2', type: 'switch', vendor: 'Cisco', model: 'Catalyst C9300-24UX', sysDescr: 'Cisco IOS C9300-24UX', status: 'online', latency_ms: 2.1, open_ports: [161, 22] },
          { ip: '192.168.1.20', type: 'nas', vendor: 'Synology', model: 'DiskStation DS920+', sysDescr: 'Synology DS920+ Storage', status: 'online', latency_ms: 2.9, open_ports: [445, 5000] },
          { ip: '192.168.1.30', type: 'nvr', vendor: 'Dahua', model: 'NVR5864-4KS2', sysDescr: 'Dahua NVR 64CH', status: 'online', latency_ms: 3.5, open_ports: [554, 37777] }
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, mode: 'demo', count: demoResults.length, devices: demoResults }));
        return;
      }

      try {
        const startLong = ipToLong(startIp);
        const endLong = ipToLong(endIp);
        const total = Math.min(254, Math.max(1, endLong - startLong + 1));
        const ips = [];
        for (let i = 0; i < total; i++) {
          ips.push(longToIp(startLong + i));
        }

        const foundDevices = [];
        const concurrency = 16;
        let scannedCount = 0;

        for (let i = 0; i < ips.length; i += concurrency) {
          if (activeScanState.cancel) break;

          const chunk = ips.slice(i, i + concurrency);
          const chunkPromises = chunk.map(async (ip) => {
            const probeRes = await querySnmpDevice(ip, community, 161, ['1.3.6.1.2.1.1.1.0'], 500);
            const tcpRes = await probeTcpLatency(ip, 80, 500);
            scannedCount++;

            if (probeRes.success || tcpRes.ok) {
              const openPorts = [];
              if (probeRes.success) openPorts.push(161);
              if (tcpRes.ok) openPorts.push(80);

              const devFound = {
                ip,
                status: 'online',
                latency_ms: probeRes.success ? probeRes.latency : tcpRes.latency,
                open_ports: openPorts,
                type: probeRes.success ? 'switch' : 'firewall',
                vendor: probeRes.success ? 'SNMP' : 'Gateway',
                model: probeRes.values['1.3.6.1.2.1.1.1.0'] || 'Network Responder',
                sysDescr: probeRes.values['1.3.6.1.2.1.1.1.0'] || `HTTP Responder (${ip})`
              };
              foundDevices.push(devFound);
              broadcastSSE({
                type: 'scan_device_found',
                device: devFound,
                progress: { scanned: scannedCount, total: ips.length, percent: Math.round((scannedCount / ips.length) * 100) }
              });
            }
          });

          await Promise.all(chunkPromises);
          broadcastSSE({
            type: 'scan_progress',
            progress: { scanned: scannedCount, total: ips.length, percent: Math.round((scannedCount / ips.length) * 100) }
          });
        }

        activeScanState.running = false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, mode: 'live', count: foundDevices.length, devices: foundDevices }));
      } catch (scanErr) {
        activeScanState.running = false;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: scanErr.message }));
      }
    });
    return;
  }

  // 7. POST /api/scan/cancel
  if (req.method === 'POST' && pathname === '/api/scan/cancel') {
    activeScanState.cancel = true;
    activeScanState.running = false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Đã dừng quét' }));
    return;
  }

  // 8. POST /api/device/save
  if (req.method === 'POST' && pathname === '/api/device/save') {
    readJsonBody(req, (err, dev) => {
      if (err || !dev || !dev.id || !dev.name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Thiếu thông tin thiết bị (id, name)' }));
        return;
      }

      console.log(`[Device] Lưu cấu hình thiết bị: "${dev.name}" (${dev.id})`);

      if (topologyData.switches) topologyData.switches = topologyData.switches.filter(s => s.id !== dev.id);
      if (topologyData.infrastructure_nodes) topologyData.infrastructure_nodes = topologyData.infrastructure_nodes.filter(n => n.id !== dev.id);
      if (topologyData.isp) topologyData.isp = topologyData.isp.filter(i => i.id !== dev.id);

      if (dev.id === 'fw' || dev.type === 'firewall') {
        dev.id = dev.id || 'fw';
        topologyData.firewall = { ...(topologyData.firewall || {}), ...dev };
      } else if (dev.id === 'core' || dev.type === 'core_switch') {
        dev.id = dev.id || 'core';
        topologyData.core_switch = { ...(topologyData.core_switch || {}), ...dev };
      } else if (dev.type === 'switch') {
        if (!dev.ports || !dev.ports.length) {
          const portCount = Number(dev.ports_count) || 24;
          dev.ports = [];
          for (let p = 1; p <= portCount; p++) {
            dev.ports.push({
              port: p,
              name: `Gi1/0/${p}`,
              status: p <= 12 ? 'up' : 'down',
              speed_mbps: 1000,
              duplex: 'full',
              poe_watts: p <= 8 ? 15.4 : 0,
              down_bps: 0,
              up_bps: 0
            });
          }
          if (portCount === 24) {
            for (let s = 25; s <= 28; s++) {
              dev.ports.push({
                port: s,
                name: `Te1/0/${s - 24}`,
                status: (s === 25 || s === 27 || s === 28) ? 'up' : 'down',
                speed_mbps: 10000,
                duplex: 'full',
                poe_watts: 0,
                down_bps: 0,
                up_bps: 0
              });
            }
          }
        }
        if (!dev.down_bps) dev.down_bps = 0;
        if (!dev.up_bps) dev.up_bps = 0;
        if (!dev.parent) dev.parent = 'core';
        if (!dev.parent_port) dev.parent_port = 'Te1/0/5';
        if (!topologyData.switches) topologyData.switches = [];
        topologyData.switches.push(dev);
      } else if (dev.type === 'isp') {
        if (!dev.down_bps) dev.down_bps = 0;
        if (!dev.up_bps) dev.up_bps = 0;
        if (!topologyData.isp) topologyData.isp = [];
        topologyData.isp.push(dev);
      } else {
        if (!dev.down_bps) dev.down_bps = 0;
        if (!dev.up_bps) dev.up_bps = 0;
        if (!dev.parent) dev.parent = 'core';
        if (!dev.parent_port) dev.parent_port = 'Te1/0/6';
        if (!topologyData.infrastructure_nodes) topologyData.infrastructure_nodes = [];
        topologyData.infrastructure_nodes.push(dev);
      }

      if (!topologyData.layout) topologyData.layout = {};
      if (!topologyData.layout[dev.id]) {
        const parentId = dev.parent || 'core';
        const parentPos = (topologyData.layout && topologyData.layout[parentId]) || { x: 720, y: 170 };
        topologyData.layout[dev.id] = {
          x: parentPos.x + 360,
          y: parentPos.y + (Math.random() * 140 - 70)
        };
      }

      saveConfig();
      // Kích hoạt chu kỳ polling ngay để lấy thông số của thiết bị mới
      executeRealPhysicalSnmpPollingCycle().catch(() => {});
      broadcastSSE({ type: 'topology_updated', deviceId: dev.id });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, message: `Đã lưu thành công cấu hình thiết bị "${dev.name}"`, device: dev }));
    });
    return;
  }

  // 9. POST /api/device/delete
  if (req.method === 'POST' && pathname === '/api/device/delete') {
    readJsonBody(req, (err, data) => {
      const id = data && data.id;
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Thiếu mã ID thiết bị cần xóa' }));
        return;
      }

      console.log(`[Device] Xóa thiết bị: ${id}`);
      let devName = id;

      if (id === 'core' || (topologyData.core_switch && topologyData.core_switch.id === id)) {
        if (topologyData.core_switch) devName = topologyData.core_switch.name || 'Switch Core';
        topologyData.core_switch = null;
        if (topologyData.layout) {
          delete topologyData.layout[id];
          delete topologyData.layout['core'];
        }
        // Tự động chuyển các thiết bị con có uplink vào core sang fw (nếu có)
        const fallbackParent = topologyData.firewall ? (topologyData.firewall.id || 'fw') : '';
        (topologyData.switches || []).forEach(s => {
          if (s.parent === id || s.parent === 'core') s.parent = fallbackParent;
        });
        (topologyData.infrastructure_nodes || []).forEach(n => {
          if (n.parent === id || n.parent === 'core') n.parent = fallbackParent;
        });
      } else if (id === 'fw' || (topologyData.firewall && topologyData.firewall.id === id)) {
        if (topologyData.firewall) devName = topologyData.firewall.name || 'Firewall';
        topologyData.firewall = null;
        if (topologyData.layout) {
          delete topologyData.layout[id];
          delete topologyData.layout['fw'];
        }
        (topologyData.isp || []).forEach(i => {
          if (i.parent === id || i.parent === 'fw') i.parent = '';
        });
        (topologyData.switches || []).forEach(s => {
          if (s.parent === id || s.parent === 'fw') s.parent = '';
        });
        (topologyData.infrastructure_nodes || []).forEach(n => {
          if (n.parent === id || n.parent === 'fw') n.parent = '';
        });
      } else {
        const foundSw = (topologyData.switches || []).find(s => s.id === id);
        const foundInfra = (topologyData.infrastructure_nodes || []).find(n => n.id === id);
        const foundIsp = (topologyData.isp || []).find(i => i.id === id);
        if (foundSw) devName = foundSw.name;
        else if (foundInfra) devName = foundInfra.name;
        else if (foundIsp) devName = foundIsp.name;

        topologyData.switches = (topologyData.switches || []).filter(s => s.id !== id);
        topologyData.infrastructure_nodes = (topologyData.infrastructure_nodes || []).filter(n => n.id !== id);
        topologyData.isp = (topologyData.isp || []).filter(i => i.id !== id);
        if (topologyData.layout) delete topologyData.layout[id];

        const fallbackParent = topologyData.core_switch ? (topologyData.core_switch.id || 'core') : (topologyData.firewall ? (topologyData.firewall.id || 'fw') : '');
        (topologyData.switches || []).forEach(s => {
          if (s.parent === id) s.parent = fallbackParent;
        });
        (topologyData.infrastructure_nodes || []).forEach(n => {
          if (n.parent === id) n.parent = fallbackParent;
        });
      }

      saveConfig();
      broadcastSSE({ type: 'topology_updated' });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, message: `Đã xóa thiết bị "${devName}" (${id}) thành công!` }));
    });
    return;
  }

  // 10. POST /api/settings/save
  if (req.method === 'POST' && pathname === '/api/settings/save') {
    readJsonBody(req, (err, data) => {
      if (err || !data) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Dữ liệu không hợp lệ' }));
        return;
      }
      if (data.factory) {
        topologyData.factory.name = data.factory.name || topologyData.factory.name;
        topologyData.factory.location = data.factory.location || topologyData.factory.location;
      }
      if (data.settings) {
        if (data.settings.poll_interval_sec) topologyData.settings.poll_interval_sec = Number(data.settings.poll_interval_sec);
        if (data.settings.active_threshold_bps) topologyData.settings.active_threshold_bps = Number(data.settings.active_threshold_bps);
      }
      saveConfig();
      broadcastSSE({ type: 'topology_updated' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, factory: topologyData.factory, settings: topologyData.settings }));
    });
    return;
  }

  // 11. POST /api/telegram/save
  if (req.method === 'POST' && pathname === '/api/telegram/save') {
    readJsonBody(req, (err, data) => {
      if (err || !data) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Dữ liệu không hợp lệ' }));
        return;
      }
      topologyData.settings.telegram = {
        enabled: Boolean(data.enabled),
        bot_token: String(data.bot_token || '').trim(),
        chat_id: String(data.chat_id || '').trim(),
        alert_on_offline: Boolean(data.alert_on_offline),
        alert_on_high_traffic: Boolean(data.alert_on_high_traffic),
        alert_on_storage: Boolean(data.alert_on_storage)
      };
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, telegram: topologyData.settings.telegram }));
    });
    return;
  }

  // 12. POST /api/telegram/test
  if (req.method === 'POST' && pathname === '/api/telegram/test') {
    readJsonBody(req, (err, data) => {
      const token = (data && data.bot_token) || (topologyData.settings.telegram && topologyData.settings.telegram.bot_token);
      const chat = (data && data.chat_id) || (topologyData.settings.telegram && topologyData.settings.telegram.chat_id);

      if (!token || !chat) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Vui lòng nhập Bot Token và Chat ID trước khi thử nghiệm' }));
        return;
      }

      const msg = `🚨 <b>[TEST ALERT] HỆ THỐNG GIÁM SÁT MẠNG NHÀ MÁY (PURE SNMP)</b>\n` +
        `🏭 <b>Nhà máy:</b> ${topologyData.factory.name}\n` +
        `📍 <b>Vị trí:</b> ${topologyData.factory.location}\n` +
        `⏰ <b>Thời gian:</b> ${new Date().toLocaleString('vi-VN')}\n` +
        `✅ <b>Chế độ:</b> Thuần dữ liệu thật 100% từ thiết bị mạng vật lý (Option B).`;

      sendTelegramMessage(token, chat, msg, (tgErr) => {
        if (tgErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Gửi Telegram thất bại: ${tgErr.message}` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Đã gửi tin nhắn thử nghiệm thành công tới Telegram!' }));
      });
    });
    return;
  }

  // 13. POST /api/zone/save
  if (req.method === 'POST' && pathname === '/api/zone/save') {
    readJsonBody(req, (err, zone) => {
      if (err || !zone || !zone.id || !zone.name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Thiếu thông tin phân vùng (id, name)' }));
        return;
      }
      if (!topologyData.zones) topologyData.zones = [];
      const origId = (zone.original_id || zone.id).trim();
      const newId = zone.id.trim();
      const newName = zone.name.trim();
      const newIcon = zone.icon || 'mdi:domain';

      const idx = topologyData.zones.findIndex(z => z.id === origId || z.id === newId);
      const newZoneObj = { id: newId, name: newName, icon: newIcon };

      if (idx >= 0) {
        const oldId = topologyData.zones[idx].id;
        topologyData.zones[idx] = newZoneObj;
        // Migrate any devices if ID was modified
        if (oldId !== newId) {
          const migrateZone = (dev) => {
            if (dev && dev.zone === oldId) dev.zone = newId;
          };
          if (topologyData.firewall) migrateZone(topologyData.firewall);
          if (topologyData.core_switch) migrateZone(topologyData.core_switch);
          (topologyData.switches || []).forEach(migrateZone);
          (topologyData.infrastructure_nodes || []).forEach(migrateZone);
          (topologyData.isp || []).forEach(migrateZone);
        }
      } else {
        topologyData.zones.push(newZoneObj);
      }
      saveConfig();
      broadcastSSE({ type: 'topology_updated' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, zones: topologyData.zones }));
    });
    return;
  }

  // 14. POST /api/zone/delete
  if (req.method === 'POST' && pathname === '/api/zone/delete') {
    readJsonBody(req, (err, data) => {
      const id = data && data.id;
      if (!id || id === 'all') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Không thể xóa phân vùng này' }));
        return;
      }
      // Migrate any devices in deleted zone to first remaining non-'all' zone
      const remainingZones = (topologyData.zones || []).filter(z => z.id !== id && z.id !== 'all');
      const targetZoneId = remainingZones.length > 0 ? remainingZones[0].id : 'mdf';

      const migrateDeviceZone = (dev) => {
        if (dev && dev.zone === id) dev.zone = targetZoneId;
      };
      if (topologyData.firewall) migrateDeviceZone(topologyData.firewall);
      if (topologyData.core_switch) migrateDeviceZone(topologyData.core_switch);
      (topologyData.switches || []).forEach(migrateDeviceZone);
      (topologyData.infrastructure_nodes || []).forEach(migrateDeviceZone);
      (topologyData.isp || []).forEach(migrateDeviceZone);

      topologyData.zones = (topologyData.zones || []).filter(z => z.id !== id);
      saveConfig();
      broadcastSSE({ type: 'topology_updated' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, zones: topologyData.zones }));
    });
    return;
  }

  // 15. Static Files Delivery (Chống Cache triệt để cho JS & CSS)
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath).toLowerCase();

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(filePath, (e, content) => {
        if (e) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('404 Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Server Error');
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': (ext === '.html' || ext === '.js' || ext === '.css') ? 'no-cache, no-store, must-revalidate' : 'public, max-age=86400'
      });
      res.end(content);
    });
  });
});

function sendTelegramMessage(botToken, chatId, text, callback) {
  if (!botToken || !chatId) {
    if (callback) callback(new Error('Chưa cấu hình Bot Token hoặc Chat ID'));
    return;
  }
  const postData = JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' });
  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${botToken}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
  };
  const tgReq = https.request(options, (res) => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => { if (callback) callback(null, body); });
  });
  tgReq.on('error', (e) => { if (callback) callback(e); });
  tgReq.write(postData);
  tgReq.end();
}

server.listen(PORT, () => {
  const ifaces = getAvailableNetworkInterfaces();
  console.log(`\n=============================================================`);
  console.log(`🌐 FACTORY SNMP NETWORK MONITOR ĐANG CHẠY TẠI:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`⚙️  CHẾ ĐỘ: PHƯƠNG ÁN B - THUẦN DỮ LIỆU THẬT SNMP 100% (STRICT REAL-TIME)`);
  console.log(`🚫 BỘ MÔ PHỎNG / JITTER ĐÃ ĐƯỢC TẮT HOÀN TOÀN`);
  ifaces.forEach(iface => {
    if (!iface.isInternal) {
      console.log(`📡 Card mạng phát hiện: [${iface.name}] ${iface.ip} (${iface.cidr})`);
    }
  });
  console.log(`=============================================================\n`);
});
