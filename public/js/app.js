/**
 * FACTORY SNMP NETWORK MONITOR - CLIENT APPLICATION (ENTERPRISE NMS)
 * - Tự động nhận diện danh sách Card mạng (Network Interfaces) máy chủ
 * - Bộ quét IP & Quét Port thực tế (TCP Port Scanner & UDP SNMP Prober)
 * - Tự động nhận dạng loại thiết bị (NVR, NAS, Switch, Firewall, Controller, Server)
 * - Thêm thiết bị phát hiện vào sơ đồ Topo với 1 cú click ("+ Thêm Vào Topo")
 * - Cấu hình Thiết bị Cha (Uplink Parent) tự động vẽ sơ đồ mạng Bezier chuẩn
 * - Chỉnh sửa / Xóa thiết bị hoàn thiện 100%, tự động đồng bộ thời gian thực
 * - Form chuyên sâu cho NVR (Kênh, Dung lượng, Ngày lưu) & NAS (RAID, Thư mục chia sẻ, User)
 * - Kiểm tra kết nối SNMP tức thì với thanh báo xanh/đỏ chi tiết
 * - Cảnh báo Telegram Bot & Tiêu đề nhà máy tùy biến trực tiếp từ Web UI
 * - Bộ điều khiển Kéo Thả (Drag & Drop) mượt mà với tự động lưu tọa độ
 */

const state = {
  topology: null,
  activeZone: 'all',
  selectedSwitches: new Set(['sw_a']),
  zoom: 0.85,
  panX: 40,
  panY: 30,
  theme: 'neon',
  flowStyle: 'galaxy',
  links: new Map(),
  rafId: null,
  currentEditingDevId: null,
  networkInterfaces: [],
  isScanning: false,

  // Central Drag & Drop Controller
  drag: {
    isDraggingNode: false,
    nodeId: null,
    nodeEl: null,
    startX: 0,
    startY: 0,
    initialX: 0,
    initialY: 0,
    moved: false,

    isPanningCanvas: false,
    panStartX: 0,
    panStartY: 0
  }
};

// ============================================================================
// SAFE DOM EVENT BINDING HELPERS (BULLETPROOF, NEVER CRASHES)
// ============================================================================
function bindClick(id, handler) {
  const el = document.getElementById(id);
  if (el) {
    el.onclick = handler;
  } else {
    console.warn(`[DOM] Element #${id} not found in HTML`);
  }
}

function bindChange(id, handler) {
  const el = document.getElementById(id);
  if (el) {
    el.onchange = handler;
  } else {
    console.warn(`[DOM] Element #${id} not found in HTML`);
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============================================================================
// FORMATTERS & MATH
// ============================================================================
function fmtRate(bps) {
  if (bps == null || isNaN(bps)) return '–';
  if (bps < 1e3) return `${Math.round(bps)} bps`;
  if (bps < 1e6) return `${(bps / 1e3).toFixed(bps < 1e4 ? 2 : 1)} Kbps`;
  if (bps < 1e9) return `${(bps / 1e6).toFixed(bps < 1e7 ? 2 : 1)} Mbps`;
  return `${(bps / 1e9).toFixed(2)} Gbps`;
}

function flowVars(bps) {
  if (!(bps > 100)) return { w: '2px', d: '0s', o: 0.3, active: false };
  const t = Math.round(Math.min(1, Math.max(0, (Math.log10(bps) - 2) / 6)) * 20) / 20;
  return {
    w: `${(2 + t * 4).toFixed(1)}px`,
    d: `${(2.6 - t * 2).toFixed(2)}s`,
    o: (0.5 + t * 0.5).toFixed(2),
    active: true
  };
}

function calculateCurve(A, B, side = false) {
  const cx = (R) => (R.l + R.r) / 2;
  const cy = (R) => (R.t + R.b) / 2;

  if (side) {
    const right = cx(B) >= cx(A);
    const x1 = right ? A.r : A.l;
    const y1 = cy(A);
    const x2 = right ? B.l : B.r;
    const y2 = cy(B);
    const s = right ? 1 : -1;
    const k = Math.max(40, Math.abs(x2 - x1) / 2);
    return {
      d: `M${x1} ${y1} C${x1 + s * k} ${y1} ${x2 - s * k} ${y2} ${x2} ${y2}`,
      mx: (x1 + x2) / 2,
      my: (y1 + y2) / 2,
      vert: false
    };
  }

  let x1, y1, x2, y2, vert = false;
  if (B.l >= A.r - 8) {
    x1 = A.r; y1 = cy(A);
    x2 = B.l; y2 = cy(B);
  } else if (B.r <= A.l + 8) {
    x1 = A.l; y1 = cy(A);
    x2 = B.r; y2 = cy(B);
  } else {
    vert = true;
    x1 = cx(A); x2 = cx(B);
    if (cy(B) >= cy(A)) { y1 = A.b; y2 = B.t; } else { y1 = A.t; y2 = B.b; }
  }

  const m = vert ? (y1 + y2) / 2 : (x1 + x2) / 2;
  const d = vert
    ? `M${x1} ${y1} C${x1} ${m} ${x2} ${m} ${x2} ${y2}`
    : `M${x1} ${y1} C${m} ${y1} ${m} ${y2} ${x2} ${y2}`;

  return { d, mx: (x1 + x2) / 2, my: (y1 + y2) / 2, vert };
}

// ============================================================================
// TOAST NOTIFICATION HELPER
// ============================================================================
function showToast(message, type = 'success') {
  let toastContainer = document.getElementById('toastContainer');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toastContainer';
    toastContainer.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 99999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
    `;
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  const bg = type === 'success' ? 'rgba(16, 185, 129, 0.95)' : type === 'error' ? 'rgba(239, 68, 68, 0.95)' : 'rgba(0, 240, 255, 0.95)';
  const color = type === 'error' || type === 'success' ? '#fff' : '#000';
  const icon = type === 'success' ? 'mdi-check-circle' : type === 'error' ? 'mdi-alert-circle' : 'mdi-information';

  toast.style.cssText = `
    background: ${bg};
    color: ${color};
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    display: flex;
    align-items: center;
    gap: 8px;
    animation: fadeIn 0.25s ease;
    pointer-events: auto;
  `;
  toast.innerHTML = `<i class="mdi ${icon}" style="font-size:18px;"></i> <span>${message}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ============================================================================
// BOOTSTRAP & INITIALIZATION
// ============================================================================
function bootstrap() {
  console.log('[App] Khởi động hệ thống Enterprise NMS...');
  try { initUIControls(); } catch (e) { console.error('Lỗi initUIControls:', e); }
  try { initDeviceModalEvents(); } catch (e) { console.error('Lỗi initDeviceModalEvents:', e); }
  try { initZoneModalEvents(); } catch (e) { console.error('Lỗi initZoneModalEvents:', e); }
  try { initSettingsModalEvents(); } catch (e) { console.error('Lỗi initSettingsModalEvents:', e); }
  try { initAlertsModalEvents(); } catch (e) { console.error('Lỗi initAlertsModalEvents:', e); }
  try { initSubnetScannerEvents(); } catch (e) { console.error('Lỗi initSubnetScannerEvents:', e); }
  try { initCentralMouseEngine(); } catch (e) { console.error('Lỗi initCentralMouseEngine:', e); }

  loadTopology();
  initSSE();
  loadNetworkInterfaces();
}

async function loadTopology() {
  try {
    const res = await fetch('/api/topology');
    state.topology = await res.json();
    console.log('[App] Đã nạp dữ liệu mạng:', state.topology);

    setupHeader();
    renderZones();
    renderTopologyNodes();
    scheduleDrawLinks();
  } catch (err) {
    console.error('[App] Lỗi nạp topology:', err);
  }
}

function initSSE() {
  const evt = new EventSource('/api/stream');

  evt.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'metrics_tick') {
        updateLiveMetrics(data);
      } else if (data.type === 'topology_updated') {
        loadTopology();
      } else if (data.type === 'scan_progress') {
        handleScanProgressSSE(data.progress);
      } else if (data.type === 'scan_device_found') {
        handleScanDeviceFoundSSE(data.device, data.progress);
      }
    } catch (err) {
      console.warn('[SSE] Parse error:', err);
    }
  };

  evt.onerror = () => {
    console.warn('[SSE] Mất kết nối tới server, đang tự kết nối lại...');
  };
}

function updateLiveMetrics(data) {
  if (!state.topology) return;

  if (data.isp !== undefined) state.topology.isp = data.isp || [];
  if (data.firewall !== undefined) state.topology.firewall = data.firewall || null;
  if (data.core_switch !== undefined) state.topology.core_switch = data.core_switch || null;
  if (data.switches !== undefined) state.topology.switches = data.switches || [];
  if (data.infrastructure_nodes !== undefined) state.topology.infrastructure_nodes = data.infrastructure_nodes || [];

  updateNodeTexts();
  updateHeaderStats();
  scheduleDrawLinks();
}

function updateNodeTexts() {
  const t = state.topology;
  if (!t) return;

  function updateVisual(id, status, downBps, upBps) {
    const el = document.querySelector(`[data-nid="${id}"]`);
    if (!el) return;

    if (downBps != null) {
      const downEl = el.querySelector('.rate-badge.down span');
      if (downEl) downEl.textContent = `↓ ${fmtRate(downBps)}`;
    }
    if (upBps != null) {
      const upEl = el.querySelector('.rate-badge.up span');
      if (upEl) upEl.textContent = `↑ ${fmtRate(upBps)}`;
    }

    if (status) {
      el.classList.remove('ok', 'warn', 'bad', 'lv1', 'lv2', 'online', 'offline', 'down');
      el.classList.add(status);
      if (status === 'warn') el.classList.add('lv1');
      if (status === 'bad' || status === 'offline' || status === 'down') el.classList.add('lv2');

      const dot = el.querySelector('.status-dot');
      if (dot) {
        dot.className = `status-dot ${status}`;
      }
    }
  }

  (t.isp || []).forEach((isp) => {
    updateVisual(isp.id, isp.status, isp.down_bps, isp.up_bps);
  });

  if (t.firewall) {
    updateVisual(t.firewall.id || 'fw', t.firewall.status, t.firewall.down_bps, t.firewall.up_bps);
  }

  if (t.core_switch) {
    updateVisual(t.core_switch.id || 'core', t.core_switch.status, t.core_switch.down_bps, t.core_switch.up_bps);
  }

  (t.switches || []).forEach((sw) => {
    updateVisual(sw.id, sw.status, sw.down_bps, sw.up_bps);
    if (state.selectedSwitches.has(sw.id) && sw.ports) {
      sw.ports.forEach((p) => {
        const pEl = document.querySelector(`[data-portid="${sw.id}_${p.port}"]`);
        if (pEl) {
          const trEl = pEl.querySelector('.port-traffic');
          if (trEl) {
            trEl.innerHTML = `<span style="color:#38bdf8">↓${fmtRate(p.down_bps)}</span><br><span style="color:#818cf8">↑${fmtRate(p.up_bps)}</span>`;
          }
        }
      });
    }
  });

  (t.infrastructure_nodes || []).forEach((n) => {
    updateVisual(n.id, n.status, n.down_bps, n.up_bps);
  });

  updateHeaderStats();
}

// CẬP NHẬT THỐNG KÊ HEADER THỰC TẾ THEO THỜI GIAN THỰC
function updateHeaderStats() {
  const t = state.topology;
  if (!t) return;

  const allDevs = [];
  if (t.firewall) allDevs.push(t.firewall);
  if (t.core_switch) allDevs.push(t.core_switch);
  (t.switches || []).forEach(s => allDevs.push(s));
  (t.infrastructure_nodes || []).forEach(n => allDevs.push(n));
  (t.isp || []).forEach(i => allDevs.push(i));

  const totalDevices = allDevs.length;
  const onlineDevices = allDevs.filter(d => d.status === 'ok' || d.status === 'online').length;
  const alertCount = allDevs.filter(d => d.status === 'warn' || d.status === 'bad' || d.status === 'offline' || d.status === 'down').length;

  // Tổng số cổng đang UP / Tổng cổng Switch mạng
  let totalPorts = 0;
  let upPorts = 0;
  const switches = [];
  if (t.core_switch) switches.push(t.core_switch);
  (t.switches || []).forEach(s => switches.push(s));

  switches.forEach(sw => {
    if (sw.ports && sw.ports.length) {
      totalPorts += sw.ports.length;
      upPorts += sw.ports.filter(p => p.status === 'up').length;
    } else {
      const cnt = Number(sw.ports_count) || 24;
      totalPorts += cnt;
      if (sw.status === 'ok') upPorts += Math.round(cnt * 0.6);
    }
  });

  // Tổng tải băng thông
  let totalDownBps = 0;
  let totalUpBps = 0;

  if (t.firewall && (t.firewall.down_bps || t.firewall.up_bps)) {
    totalDownBps = t.firewall.down_bps || 0;
    totalUpBps = t.firewall.up_bps || 0;
  } else if (t.isp && t.isp.length && (t.isp[0].down_bps || t.isp[0].up_bps)) {
    totalDownBps = t.isp[0].down_bps || 0;
    totalUpBps = t.isp[0].up_bps || 0;
  } else {
    allDevs.forEach(d => {
      totalDownBps += (d.down_bps || 0);
      totalUpBps += (d.up_bps || 0);
    });
  }

  const elDevs = document.getElementById('statDevicesOnline');
  const elPorts = document.getElementById('statPortsUp');
  const elDown = document.getElementById('statTotalDown');
  const elUp = document.getElementById('statTotalUp');
  const elAlert = document.getElementById('statAlertCount');

  if (elDevs) elDevs.textContent = `${onlineDevices} / ${totalDevices}`;
  if (elPorts) elPorts.textContent = `${upPorts} / ${totalPorts}`;
  if (elDown) elDown.textContent = fmtRate(totalDownBps);
  if (elUp) elUp.textContent = fmtRate(totalUpBps);
  if (elAlert) {
    elAlert.textContent = `${alertCount}`;
    const alertPill = elAlert.closest('.stat-pill');
    if (alertPill) {
      if (alertCount > 0) alertPill.classList.add('alert-pill');
      else alertPill.classList.remove('alert-pill');
    }
  }
}

// ============================================================================
// HEADER & ZONES
// ============================================================================
function setupHeader() {
  if (!state.topology || !state.topology.factory) return;
  const f = state.topology.factory;
  const nameEl = document.getElementById('factoryName');
  const locEl = document.getElementById('factoryLocation');
  if (nameEl) nameEl.textContent = f.name;
  if (locEl) locEl.textContent = f.location;
  updateHeaderStats();
}

function renderZones() {
  const container = document.getElementById('zoneChips');
  if (!container) return;
  container.innerHTML = '';
  if (!state.topology || !state.topology.zones) return;

  state.topology.zones.forEach((z) => {
    const chip = document.createElement('div');
    chip.className = `zone-chip ${z.id === state.activeZone ? 'active' : ''}`;
    chip.dataset.zone = z.id;
    chip.innerHTML = `<i class="mdi ${z.icon}"></i> ${z.name}`;
    chip.onclick = () => selectZone(z.id);
    container.appendChild(chip);
  });
}

function selectZone(zoneId) {
  state.activeZone = zoneId;
  document.querySelectorAll('.zone-chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.zone === zoneId);
  });

  document.querySelectorAll('.topo-node').forEach((el) => {
    if (zoneId === 'all') {
      el.classList.remove('dimmed');
    } else {
      const nodeZone = el.dataset.zone;
      el.classList.toggle('dimmed', nodeZone && nodeZone !== zoneId);
    }
  });
  scheduleDrawLinks();
}

// ============================================================================
// TOPOLOGY NODES RENDERER
// ============================================================================
function renderTopologyNodes() {
  const container = document.getElementById('topoNodesLayer');
  if (!container) return;
  container.innerHTML = '';
  const t = state.topology;
  if (!t) return;

  const allNodes = [];

  // 1. ISP Nodes
  (t.isp || []).forEach((isp) => {
    allNodes.push({
      id: isp.id,
      title: isp.name,
      subtitle: `${isp.ip} · ${isp.speed_mbps}Mbps`,
      icon: 'mdi-earth',
      status: isp.status === 'online' ? 'ok' : 'bad',
      down: isp.down_bps,
      up: isp.up_bps,
      zone: 'mdf',
      extra: [`${isp.latency_ms}ms`, `${isp.loss_pct}% loss`]
    });
  });

  // 2. Firewall
  const fw = t.firewall;
  if (fw) {
    allNodes.push({
      id: fw.id || 'fw',
      title: fw.name,
      subtitle: `${fw.ip} · ${fw.model || 'Firewall'}`,
      icon: 'mdi-shield-lock',
      status: fw.status || 'ok',
      down: fw.down_bps,
      up: fw.up_bps,
      zone: fw.zone || 'mdf',
      extra: [`CPU ${fw.cpu || 25}%`, `RAM ${fw.ram || 40}%`, `${fw.sessions || 10000} sess`]
    });
  }

  // 3. Core Switch
  const core = t.core_switch;
  if (core) {
    allNodes.push({
      id: core.id || 'core',
      title: core.name,
      subtitle: `${core.ip} · ${core.model || 'Core 10G'}`,
      icon: 'mdi-lan-connect',
      status: core.status || 'ok',
      down: core.down_bps,
      up: core.up_bps,
      zone: core.zone || 'mdf',
      extra: [`CPU ${core.cpu || 15}%`, `${core.temp_c || 36}°C`, '10G Uplink']
    });
  }

  // 4. Access Switches
  (t.switches || []).forEach((sw) => {
    allNodes.push({
      id: sw.id,
      title: sw.name,
      subtitle: `${sw.ip} · ${sw.model || 'Switch'}`,
      icon: 'mdi-lan-connect',
      status: sw.status || 'ok',
      down: sw.down_bps,
      up: sw.up_bps,
      zone: sw.zone,
      extra: [`CPU ${sw.cpu || 20}%`, `${sw.poe_used_watts || 0}W / ${sw.poe_total_watts || 0}W`]
    });
  });

  // 5. Infrastructure Nodes (NAS, NVR, Controller, UPS, Server)
  (t.infrastructure_nodes || []).forEach((n) => {
    const iconMap = {
      nas: 'mdi-server',
      nvr: 'mdi-cctv',
      controller: 'mdi-access-point-network',
      ap: 'mdi-wifi',
      ups: 'mdi-battery-charging',
      server: 'mdi-server-network'
    };
    let extraList = [];
    if (n.type === 'nvr' && n.nvr_details) {
      extraList = [`${n.nvr_details.active_channels || 0}/${n.nvr_details.total_channels || 0} Cams`, `${n.nvr_details.storage_used_tb || 0}/${n.nvr_details.storage_total_tb || 0}TB`, `Lưu ${n.nvr_details.retention_target_days || 30}d`];
    } else if (n.type === 'nas' && n.nas_details) {
      extraList = [`${n.nas_details.storage_used_tb || 0}/${n.nas_details.storage_total_tb || 0}TB`, n.nas_details.raid_type || 'RAID'];
    } else if (n.type === 'controller') {
      extraList = [`${n.managed_aps || 8} APs`, `${n.online_clients || 100} Clients`];
    } else if (n.type === 'ups') {
      extraList = [`Pin: ${n.battery_pct || 100}%`, `Tải: ${n.load_pct || 40}%`];
    } else {
      extraList = [`CPU ${n.cpu || 25}%`, `RAM ${n.ram || 50}%`];
    }

    allNodes.push({
      id: n.id,
      title: n.name,
      subtitle: `${n.ip} · ${n.model || ''}`,
      icon: iconMap[n.type] || 'mdi-server',
      status: n.status || 'ok',
      down: n.down_bps,
      up: n.up_bps,
      zone: n.zone,
      extra: extraList
    });
  });

  // Render draggable elements with layout coordinates
  allNodes.forEach((nodeOpt) => {
    const el = createDraggableNode(nodeOpt);
    container.appendChild(el);
  });

  renderExpandedPorts();
}

function createDraggableNode(opt) {
  const el = document.createElement('div');
  const isBad = opt.status === 'bad' || opt.status === 'offline' || opt.status === 'down';
  const isWarn = opt.status === 'warn' || opt.status === 'warning';
  el.className = `topo-node ${opt.status} ${isWarn ? 'lv1' : isBad ? 'lv2' : ''}`;
  el.dataset.nid = opt.id;
  el.dataset.zone = opt.zone || 'all';

  const layout = (state.topology && state.topology.layout) || {};
  const pos = layout[opt.id] || { x: 500, y: 300 };
  el.style.left = `${pos.x}px`;
  el.style.top = `${pos.y}px`;

  let extraHtml = '';
  if (opt.extra && opt.extra.length) {
    extraHtml = `<div class="node-extra-info">
      ${opt.extra.map((x, i) => `<span class="extra-pill ${i === 0 ? 'extra-cpu' : ''}">${x}</span>`).join('')}
    </div>`;
  }

  el.innerHTML = `
    <div class="node-header">
      <div class="node-icon-title">
        <i class="mdi ${opt.icon} node-icon"></i>
        <div class="node-title">${opt.title}</div>
      </div>
      <div class="node-actions-right">
        <button class="node-quick-edit" title="Chỉnh sửa thiết bị này"><i class="mdi mdi-pencil"></i></button>
        <span class="status-dot ${opt.status}"></span>
      </div>
    </div>
    <div class="node-body">
      <div class="node-ip-model">
        <span>${opt.subtitle}</span>
      </div>
      <div class="node-rates">
        <span class="rate-badge down"><i class="mdi mdi-arrow-down-bold"></i> <span>↓ ${fmtRate(opt.down)}</span></span>
        <span class="rate-badge up"><i class="mdi mdi-arrow-up-bold"></i> <span>↑ ${fmtRate(opt.up)}</span></span>
      </div>
      ${extraHtml}
    </div>
  `;

  // Quick Edit Button handler
  const btnEdit = el.querySelector('.node-quick-edit');
  if (btnEdit) {
    btnEdit.onclick = (e) => {
      e.stopPropagation();
      openEditDeviceModal(opt.id);
    };
  }

  // Click on node (when not dragging)
  el.onclick = (e) => {
    if (el.dataset.wasDragged === 'true') {
      delete el.dataset.wasDragged;
      return;
    }
    handleNodeClick(opt.id);
  };

  return el;
}

// ============================================================================
// CENTRAL MOUSE & DRAG ENGINE
// ============================================================================
function initCentralMouseEngine() {
  const viewport = document.getElementById('topoViewport');
  const container = document.getElementById('zoomContainer');
  if (!viewport || !container) return;

  function updateTransform() {
    container.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    const lbl = document.getElementById('lblZoomLevel');
    if (lbl) lbl.textContent = `${Math.round(state.zoom * 100)}%`;
    scheduleDrawLinks();
  }

  // Wheel zoom
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
    state.zoom = Math.min(2.0, Math.max(0.35, state.zoom * zoomFactor));
    updateTransform();
  }, { passive: false });

  // Mousedown delegation
  window.addEventListener('mousedown', (e) => {
    const nodeEl = e.target.closest('.topo-node');

    if (nodeEl && !e.target.closest('.node-quick-edit') && e.button === 0) {
      state.drag.isDraggingNode = true;
      state.drag.nodeEl = nodeEl;
      state.drag.nodeId = nodeEl.dataset.nid;
      state.drag.startX = e.clientX;
      state.drag.startY = e.clientY;
      state.drag.initialX = parseInt(nodeEl.style.left) || 0;
      state.drag.initialY = parseInt(nodeEl.style.top) || 0;
      state.drag.moved = false;

      nodeEl.classList.add('dragging');
      e.stopPropagation();
      return;
    }

    if (e.target.closest('#topoViewport') && !e.target.closest('.modal-card') && !e.target.closest('.device-drawer') && !e.target.closest('.zoom-controls')) {
      state.drag.isPanningCanvas = true;
      state.drag.panStartX = e.clientX - state.panX;
      state.drag.panStartY = e.clientY - state.panY;
    }
  });

  // Mousemove
  window.addEventListener('mousemove', (e) => {
    if (state.drag.isDraggingNode && state.drag.nodeEl) {
      const dx = (e.clientX - state.drag.startX) / state.zoom;
      const dy = (e.clientY - state.drag.startY) / state.zoom;

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        state.drag.moved = true;
        state.drag.nodeEl.dataset.wasDragged = 'true';
      }

      const newX = Math.round(state.drag.initialX + dx);
      const newY = Math.round(state.drag.initialY + dy);

      state.drag.nodeEl.style.left = `${newX}px`;
      state.drag.nodeEl.style.top = `${newY}px`;

      if (state.topology && state.topology.layout) {
        state.topology.layout[state.drag.nodeId] = { x: newX, y: newY };
      }

      const portCol = document.querySelector(`.ports-column[data-swid="${state.drag.nodeId}"]`);
      if (portCol) {
        portCol.style.left = `${newX + 270}px`;
        portCol.style.top = `${newY}px`;
      }

      scheduleDrawLinks();
      return;
    }

    if (state.drag.isPanningCanvas) {
      state.panX = e.clientX - state.drag.panStartX;
      state.panY = e.clientY - state.drag.panStartY;
      updateTransform();
    }
  });

  // Mouseup
  window.addEventListener('mouseup', () => {
    if (state.drag.isDraggingNode && state.drag.nodeEl) {
      state.drag.nodeEl.classList.remove('dragging');
      if (state.drag.moved) {
        const finalX = parseInt(state.drag.nodeEl.style.left) || 0;
        const finalY = parseInt(state.drag.nodeEl.style.top) || 0;
        saveNodePosition(state.drag.nodeId, finalX, finalY);
      }
      state.drag.isDraggingNode = false;
      state.drag.nodeEl = null;
      state.drag.nodeId = null;
    }

    state.drag.isPanningCanvas = false;
  });

  updateTransform();
}

async function saveNodePosition(nodeId, x, y) {
  try {
    await fetch('/api/node/position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: nodeId, x, y })
    });
  } catch (err) {
    console.error('Lỗi lưu vị trí:', err);
  }
}

function handleNodeClick(nodeId) {
  const sw = (state.topology && state.topology.switches || []).find((s) => s.id === nodeId);
  if (sw) {
    if (state.selectedSwitches.has(nodeId)) {
      state.selectedSwitches.delete(nodeId);
    } else {
      state.selectedSwitches.add(nodeId);
    }
    renderExpandedPorts();
    scheduleDrawLinks();
    return;
  }
  openDeviceDrawer(nodeId);
}

// ============================================================================
// EXPANDED PORT MATRIX COLUMN
// ============================================================================
function renderExpandedPorts() {
  const container = document.getElementById('portsColumns');
  if (!container) return;
  container.innerHTML = '';
  const t = state.topology;
  if (!t || !t.switches) return;

  const layout = t.layout || {};

  state.selectedSwitches.forEach((swId) => {
    const sw = t.switches.find((s) => s.id === swId);
    if (!sw || !sw.ports) return;

    const pos = layout[swId] || { x: 500, y: 300 };
    const col = document.createElement('div');
    col.className = 'ports-column';
    col.dataset.swid = swId;
    col.style.left = `${pos.x + 270}px`;
    col.style.top = `${pos.y}px`;

    const header = document.createElement('div');
    header.className = 'ports-column-header';
    header.innerHTML = `
      <span><i class="mdi mdi-matrix"></i> ${sw.name} (Ports)</span>
      <button class="ports-close-btn" onclick="closePortCol('${swId}')"><i class="mdi mdi-close"></i></button>
    `;
    col.appendChild(header);

    const list = document.createElement('div');
    list.className = 'ports-column-list';

    sw.ports.forEach((p) => {
      const item = document.createElement('div');
      item.className = `port-matrix-item ${p.status}`;
      item.dataset.nid = `p_${swId}_${p.port}`;
      item.dataset.portid = `${swId}_${p.port}`;

      const ledClass = p.status === 'up' ? (p.poe_watts > 0 ? 'poe' : 'up') : 'down';

      item.innerHTML = `
        <span class="port-led ${ledClass}"></span>
        <span class="port-number">#${p.port}</span>
        <span class="port-name">${p.name || `P${p.port}`}</span>
        <span class="port-traffic">
          <span style="color:#38bdf8">↓${fmtRate(p.down_bps)}</span><br>
          <span style="color:#818cf8">↑${fmtRate(p.up_bps)}</span>
        </span>
      `;
      list.appendChild(item);
    });

    col.appendChild(list);
    container.appendChild(col);
  });
}

window.closePortCol = function(swId) {
  state.selectedSwitches.delete(swId);
  renderExpandedPorts();
  scheduleDrawLinks();
};

// ============================================================================
// SVG CONNECTIONS ENGINE
// ============================================================================
function scheduleDrawLinks() {
  if (state.rafId) return;
  state.rafId = requestAnimationFrame(() => {
    state.rafId = null;
    drawLinks();
  });
}

function drawLinks() {
  const svg = document.getElementById('topoLinksSvg');
  const container = document.getElementById('zoomContainer');
  const t = state.topology;
  if (!svg || !container || !t) return;

  const baseRect = container.getBoundingClientRect();
  const z = state.zoom;

  const rects = new Map();
  document.querySelectorAll('[data-nid]').forEach((el) => {
    const r = el.getBoundingClientRect();
    rects.set(el.dataset.nid, {
      l: (r.left - baseRect.left) / z,
      r: (r.right - baseRect.left) / z,
      t: (r.top - baseRect.top) / z,
      b: (r.bottom - baseRect.top) / z
    });
  });

  const linksToDraw = [];

  // WAN Links: ISP -> Firewall
  (t.isp || []).forEach((isp) => {
    if (t.firewall) {
      linksToDraw.push({
        id: `${isp.id}>fw`,
        from: isp.id,
        to: 'fw',
        bps: (isp.down_bps || 0) + (isp.up_bps || 0),
        down: isp.down_bps,
        up: isp.up_bps,
        status: isp.status === 'online' ? 'ok' : 'bad'
      });
    }
  });

  // LAN Uplink: Firewall -> Core Switch
  if (t.firewall && t.core_switch) {
    linksToDraw.push({
      id: `fw>core`,
      from: 'fw',
      to: 'core',
      bps: (t.core_switch.down_bps || 0) + (t.core_switch.up_bps || 0),
      down: t.core_switch.down_bps,
      up: t.core_switch.up_bps,
      status: 'ok'
    });
  }

  // Distribution Links: Core Switch -> Access Switches (or custom parent)
  (t.switches || []).forEach((sw) => {
    const parentId = sw.parent || 'core';
    linksToDraw.push({
      id: `${parentId}>${sw.id}`,
      from: parentId,
      to: sw.id,
      bps: (sw.down_bps || 0) + (sw.up_bps || 0),
      down: sw.down_bps,
      up: sw.up_bps,
      status: sw.status || 'ok'
    });

    if (state.selectedSwitches.has(sw.id)) {
      (sw.ports || []).forEach((p) => {
        linksToDraw.push({
          id: `${sw.id}>p_${sw.id}_${p.port}`,
          from: sw.id,
          to: `p_${sw.id}_${p.port}`,
          bps: (p.down_bps || 0) + (p.up_bps || 0),
          side: true,
          status: p.status === 'up' ? 'ok' : 'bad'
        });
      });
    }
  });

  // Infra Links: Parent -> Device
  (t.infrastructure_nodes || []).forEach((n) => {
    const parentId = n.parent || 'core';
    linksToDraw.push({
      id: `${parentId}>${n.id}`,
      from: parentId,
      to: n.id,
      bps: (n.down_bps || 0) + (n.up_bps || 0),
      down: n.down_bps,
      up: n.up_bps,
      status: n.status || 'ok'
    });
  });

  const keep = new Set();
  const NS = 'http://www.w3.org/2000/svg';
  const isGalaxy = state.flowStyle === 'galaxy';

  linksToDraw.forEach((lk) => {
    const A = rects.get(lk.from);
    const B = rects.get(lk.to);
    if (!A || !B) return;

    keep.add(lk.id);
    let entry = state.links.get(lk.id);

    if (!entry) {
      const p = document.createElementNS(NS, 'path');
      svg.appendChild(p);

      let txt = null;
      if (lk.down != null && lk.up != null) {
        txt = document.createElementNS(NS, 'text');
        const s1 = document.createElementNS(NS, 'tspan');
        const s2 = document.createElementNS(NS, 'tspan');
        txt.appendChild(s1);
        txt.appendChild(s2);
        svg.appendChild(txt);
      }

      entry = { p, txt, layers: null };
      state.links.set(lk.id, entry);
    }

    const g = calculateCurve(A, B, lk.side);
    const fv = flowVars(lk.bps);

    if (isGalaxy && !entry.layers) {
      entry.layers = [0, 1, 2].map((i) => {
        const lp = document.createElementNS(NS, 'path');
        lp.setAttribute('class', `gl${i}`);
        svg.appendChild(lp);
        return lp;
      });
    } else if (!isGalaxy && entry.layers) {
      entry.layers.forEach((l) => l.remove());
      entry.layers = null;
    }

    entry.p.setAttribute('d', g.d);
    entry.p.setAttribute('class', lk.status === 'bad' ? 'bad' : !fv.active ? 'idle' : (isGalaxy ? 'gx' : ''));
    entry.p.style.setProperty('--w', fv.w);
    entry.p.style.setProperty('--d', fv.d);
    entry.p.style.setProperty('--o', fv.o);

    if (entry.layers) {
      entry.layers.forEach((lp, idx) => {
        lp.setAttribute('d', g.d);
        lp.setAttribute('class', `gl${idx}`);
        lp.style.setProperty('--d', fv.d);
      });
    }

    if (entry.txt && lk.down != null) {
      const [s1, s2] = entry.txt.childNodes;
      s1.textContent = `↓ ${fmtRate(lk.down)}`;
      s2.textContent = `↑ ${fmtRate(lk.up)}`;

      const x = g.vert ? g.mx + 8 : g.mx;
      const y = g.vert ? g.my - 4 : g.my - 14;

      entry.txt.setAttribute('text-anchor', g.vert ? 'start' : 'middle');
      s1.setAttribute('x', x);
      s1.setAttribute('y', y);
      s2.setAttribute('x', x);
      s2.setAttribute('y', y + 12);
    }
  });

  for (const [id, entry] of state.links) {
    if (!keep.has(id)) {
      entry.p.remove();
      if (entry.layers) entry.layers.forEach((l) => l.remove());
      if (entry.txt) entry.txt.remove();
      state.links.delete(id);
    }
  }
}

// ============================================================================
// DEVICE DRAWER
// ============================================================================
function findDevice(nodeId) {
  const t = state.topology;
  if (!t) return null;
  return (t.switches || []).find((s) => s.id === nodeId)
    || (t.firewall && t.firewall.id === nodeId ? t.firewall : null)
    || (t.core_switch && t.core_switch.id === nodeId ? t.core_switch : null)
    || (t.infrastructure_nodes || []).find((n) => n.id === nodeId)
    || (t.isp || []).find((i) => i.id === nodeId);
}

function openDeviceDrawer(nodeId) {
  state.currentEditingDevId = nodeId;
  const dev = findDevice(nodeId);
  if (!dev) return;

  const drawer = document.getElementById('deviceDrawer');
  const title = document.getElementById('drawerTitle');
  const subtitle = document.getElementById('drawerSubtitle');
  const body = document.getElementById('drawerBody');
  if (!drawer || !title || !subtitle || !body) return;

  title.textContent = dev.name;
  subtitle.textContent = `${dev.ip || '–'} · ${dev.model || ''}`;

  let specialHtml = '';

  // NVR Details
  if (dev.type === 'nvr' && dev.nvr_details) {
    const nd = dev.nvr_details;
    specialHtml = `
      <div class="drawer-section">
        <div class="section-title"><i class="mdi mdi-cctv"></i> THÔNG SỐ ĐẦU GHI CAMERA (NVR)</div>
        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-card-label">SỐ KÊNH CAMERA</div>
            <div class="metric-card-value">${nd.active_channels || 0} / ${nd.total_channels || 0} CH</div>
          </div>
          <div class="metric-card">
            <div class="metric-card-label">THỜI GIAN LƯU TRỮ</div>
            <div class="metric-card-value">${nd.retention_target_days || 30} Ngày</div>
          </div>
          <div class="metric-card">
            <div class="metric-card-label">DUNG LƯỢNG Ổ CỨNG</div>
            <div class="metric-card-value">${nd.storage_used_tb || 0} / ${nd.storage_total_tb || 0} TB</div>
          </div>
          <div class="metric-card">
            <div class="metric-card-label">CHUẨN NÉN</div>
            <div class="metric-card-value" style="font-size:12px;">${nd.codec || 'H.265+'}</div>
          </div>
        </div>
      </div>
    `;
  }

  // NAS Details
  if (dev.type === 'nas' && dev.nas_details) {
    const nas = dev.nas_details;
    const foldersHtml = (nas.shared_folders || []).map(f => `
      <tr>
        <td><strong>${f.name}</strong></td>
        <td>${(f.size_gb / 1000).toFixed(1)} TB</td>
        <td><span class="extra-pill">${f.access_group || 'All'}</span></td>
        <td>${f.desc || ''}</td>
      </tr>
    `).join('');

    const usersHtml = (nas.user_accounts || []).map(u => `
      <tr>
        <td><strong>${u.username}</strong></td>
        <td>${u.full_name || ''}</td>
        <td><span class="extra-pill">${u.role || ''}</span></td>
        <td><span class="port-led up"></span> ${u.status || 'Active'}</td>
      </tr>
    `).join('');

    specialHtml = `
      <div class="drawer-section">
        <div class="section-title"><i class="mdi mdi-server"></i> DUNG LƯỢNG & RAID LƯU TRỮ (NAS)</div>
        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-card-label">DUNG LƯỢNG ĐÃ DÙNG</div>
            <div class="metric-card-value">${nas.storage_used_tb || 0} / ${nas.storage_total_tb || 0} TB</div>
          </div>
          <div class="metric-card">
            <div class="metric-card-label">CẤU HÌNH RAID</div>
            <div class="metric-card-value" style="font-size:13px;">${nas.raid_type || 'RAID 5'}</div>
          </div>
        </div>
      </div>
      <div class="drawer-section">
        <div class="section-title"><i class="mdi mdi-folder-network"></i> THƯ MỤC CHIA SẺ (${(nas.shared_folders || []).length})</div>
        <table class="port-matrix-table">
          <thead><tr><th>Thư mục</th><th>Dung lượng</th><th>Quyền</th><th>Ghi chú</th></tr></thead>
          <tbody>${foldersHtml || '<tr><td colspan="4" style="text-align:center;">Chưa có thư mục chia sẻ</td></tr>'}</tbody>
        </table>
      </div>
      <div class="drawer-section">
        <div class="section-title"><i class="mdi mdi-account-group"></i> TÀI KHOẢN NGƯỜI DÙNG (${(nas.user_accounts || []).length})</div>
        <table class="port-matrix-table">
          <thead><tr><th>Username</th><th>Tên</th><th>Quyền</th><th>Trạng thái</th></tr></thead>
          <tbody>${usersHtml || '<tr><td colspan="4" style="text-align:center;">Chưa có tài khoản</td></tr>'}</tbody>
        </table>
      </div>
    `;
  }

  // Switch Ports Table
  let portTableHtml = '';
  if (dev.ports && dev.ports.length) {
    const rows = dev.ports.map(p => `
      <tr>
        <td><span class="port-led ${p.status === 'up' ? (p.poe_watts > 0 ? 'poe' : 'up') : 'down'}"></span> #${p.port}</td>
        <td><strong>${p.name}</strong></td>
        <td><span class="status-badge ${p.status}">${p.status.toUpperCase()}</span></td>
        <td>${p.speed_mbps}M</td>
        <td>${p.poe_watts ? p.poe_watts + 'W' : '–'}</td>
        <td style="color:#38bdf8">↓${fmtRate(p.down_bps)}</td>
        <td style="color:#818cf8">↑${fmtRate(p.up_bps)}</td>
      </tr>
    `).join('');

    portTableHtml = `
      <div class="drawer-section">
        <div class="section-title"><i class="mdi mdi-matrix"></i> MA TRẬN CỔNG SWITCH (${dev.ports.length} PORTS)</div>
        <table class="port-matrix-table">
          <thead><tr><th>Cổng</th><th>Tên</th><th>Link</th><th>Speed</th><th>PoE</th><th>Down</th><th>Up</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  body.innerHTML = `
    <div class="drawer-section">
      <div class="section-title"><i class="mdi mdi-information-outline"></i> THÔNG TIN KỸ THUẬT</div>
      <div class="metrics-grid">
        <div class="metric-card">
          <div class="metric-card-label">ĐỊA CHỈ IP</div>
          <div class="metric-card-value" style="font-size:13px;">${dev.ip || '–'}</div>
        </div>
        <div class="metric-card">
          <div class="metric-card-label">PHÂN VÙNG (ZONE)</div>
          <div class="metric-card-value" style="font-size:13px;">${dev.zone || 'MDF'}</div>
        </div>
        <div class="metric-card">
          <div class="metric-card-label">LƯU LƯỢNG DOWNLOAD</div>
          <div class="metric-card-value" style="color:#38bdf8">${fmtRate(dev.down_bps)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-card-label">LƯU LƯỢNG UPLOAD</div>
          <div class="metric-card-value" style="color:#818cf8">${fmtRate(dev.up_bps)}</div>
        </div>
      </div>
    </div>
    ${specialHtml}
    ${portTableHtml}
  `;

  drawer.classList.add('open');
}

// ============================================================================
// DEVICE CREATE / EDIT MODAL & SNMP TEST
// ============================================================================
function initDeviceModalEvents() {
  const modal = document.getElementById('deviceEditModal');
  const form = document.getElementById('deviceEditForm');

  bindClick('btnDeviceModalClose', () => modal && modal.classList.remove('open'));
  bindClick('btnCancelDeviceModal', () => modal && modal.classList.remove('open'));
  bindClick('btnAddDevice', () => openCreateDeviceModal());

  bindChange('editDevType', (e) => handleDeviceTypeChange(e.target.value));

  // Quick Zone creation button
  bindClick('btnQuickAddZone', async () => {
    const name = prompt('Nhập tên phân xưởng / khu vực mới:');
    if (!name || !name.trim()) return;

    const id = 'zone_' + Date.now().toString(36);
    try {
      const res = await fetch('/api/zone/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: name.trim(), icon: 'mdi:domain' })
      });
      const d = await res.json();
      if (d.success) {
        state.topology.zones = d.zones;
        renderZones();
        populateZoneDropdown(id);
        showToast(`Đã tạo khu vực "${name}" thành công!`);
      }
    } catch (e) {
      alert('Lỗi tạo khu vực: ' + e.message);
    }
  });

  // Real-time SNMP Test Connection button (ID: btnTestDeviceSnmp in HTML)
  bindClick('btnTestDeviceSnmp', async () => {
    const ip = document.getElementById('editDevIp').value.trim();
    const community = document.getElementById('editDevSnmpCommunity').value.trim();
    const version = document.getElementById('editDevSnmpVer').value;
    const port = document.getElementById('editDevSnmpPort').value;
    const type = document.getElementById('editDevType').value;
    const vendor = document.getElementById('editDevVendor').value;
    const model = document.getElementById('editDevModel').value;

    if (!ip) {
      alert('Vui lòng nhập địa chỉ IP trước khi kiểm tra kết nối!');
      return;
    }

    const resBox = document.getElementById('snmpTestResult');
    if (resBox) {
      resBox.style.display = 'block';
      resBox.className = 'snmp-test-result';
      resBox.innerHTML = `<i class="mdi mdi-loading mdi-spin"></i> Đang gửi gói tin kiểm tra tới ${ip}:${port}...`;
    }

    try {
      const res = await fetch('/api/device/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, community, version, port, type, vendor, model })
      });
      const d = await res.json();

      if (resBox) {
        if (d.success) {
          setEditDeviceStatusDisplay('ok');
          resBox.className = 'snmp-test-result success';
          resBox.innerHTML = `
            <strong><i class="mdi mdi-check-circle"></i> KẾT NỐI THÀNH CÔNG! (${d.latency_ms} ms)</strong><br>
            <span>• Địa chỉ IP: ${d.ip} | Port: ${d.port} | SNMP v${d.snmp_version || '2c'}</span><br>
            <span>• sysDescr: ${d.sysDescr || 'OK'}</span><br>
            <span>• Thời gian hoạt động (UpTime): ${d.sysUpTime || 'Online'}</span>
            ${d.sensors_discovered ? `<br><span>• Chỉ số SNMP tìm thấy: ${Object.keys(d.sensors_discovered).filter(k => d.sensors_discovered[k] && d.sensors_discovered[k].available).map(k => k.toUpperCase()).join(', ')}</span>` : ''}
            ${d.interfaces && d.interfaces.length ? `<br><span>• Đã quét thấy ${d.interfaces.length} cổng mạng (${d.interfaces.filter(i => i.status === 'up').length} cổng UP)` : ''}
            ${d.note ? `<br><small style="color:#fcd34d;">• ${d.note}</small>` : ''}
          `;

          // Khi quét thành công: Mở bảng cảm biến & cổng mạng thực tế
          const waitBox = document.getElementById('snmpSensorsWaitingBox');
          const contentBox = document.getElementById('snmpSensorsContentBox');
          if (waitBox) waitBox.style.display = 'none';
          if (contentBox) contentBox.style.display = 'block';

          // Tự động kích hoạt các cảm biến tìm thấy và cập nhật nhãn trạng thái
          if (d.sensors_discovered) {
            const sd = d.sensors_discovered;
            if (sd.cpu) {
              document.getElementById('chkSensorCpu').checked = !!sd.cpu.available;
              const hint = document.getElementById('hintSensorCpu');
              if (hint) {
                hint.innerHTML = sd.cpu.available
                  ? `<span style="color:#34d399; font-weight:600;"><i class="mdi mdi-check-circle"></i> OID CPU hợp lệ (${sd.cpu.value}%)</span>`
                  : `<span style="color:var(--text-dim);"><i class="mdi mdi-information-outline"></i> Thiết bị không hỗ trợ OID CPU</span>`;
              }
            }
            if (sd.ram) {
              document.getElementById('chkSensorRam').checked = !!sd.ram.available;
              const hint = document.getElementById('hintSensorRam');
              if (hint) {
                hint.innerHTML = sd.ram.available
                  ? `<span style="color:#34d399; font-weight:600;"><i class="mdi mdi-check-circle"></i> OID RAM hợp lệ (${sd.ram.value}%)</span>`
                  : `<span style="color:var(--text-dim);"><i class="mdi mdi-information-outline"></i> Thiết bị không hỗ trợ OID RAM</span>`;
              }
            }
            if (sd.temp) {
              document.getElementById('chkSensorTemp').checked = !!sd.temp.available;
              const hint = document.getElementById('hintSensorTemp');
              if (hint) {
                hint.innerHTML = sd.temp.available
                  ? `<span style="color:#34d399; font-weight:600;"><i class="mdi mdi-check-circle"></i> Cảm biến nhiệt độ (${sd.temp.value}°C)</span>`
                  : `<span style="color:var(--text-dim);"><i class="mdi mdi-information-outline"></i> Không có cảm biến nhiệt</span>`;
              }
            }
            if (sd.uptime) {
              document.getElementById('chkSensorUptime').checked = !!sd.uptime.available;
            }
            if (sd.sessions) {
              document.getElementById('chkSensorSessions').checked = !!sd.sessions.available;
            }
            if (sd.storage) {
              document.getElementById('chkSensorStorage').checked = !!sd.storage.available;
            }
          }

          // Nạp các cổng mạng thực tế phát hiện được
          if (Array.isArray(d.interfaces) && d.interfaces.length > 0) {
            renderPortsSelectTable(d.interfaces);
          }
        } else {
          setEditDeviceStatusDisplay('bad');
          resBox.className = 'snmp-test-result error';
          resBox.innerHTML = `<strong><i class="mdi mdi-close-circle"></i> KẾT NỐI THẤT BẠI</strong><br><span>${escapeHtml(d.error || 'Timeout không có phản hồi')}</span>`;
        }
      }
    } catch (e) {
      if (resBox) {
        resBox.className = 'snmp-test-result error';
        resBox.innerHTML = `<strong><i class="mdi mdi-close-circle"></i> LỖI KIỂM TRA:</strong> ${e.message}`;
      }
    }
  });

  // Bulk Interface Selection actions
  bindClick('btnSelectAllPorts', () => {
    document.querySelectorAll('#portsSelectTbody .port-monitored-chk').forEach(c => c.checked = true);
  });
  bindClick('btnDeselectAllPorts', () => {
    document.querySelectorAll('#portsSelectTbody .port-monitored-chk').forEach(c => c.checked = false);
  });
  bindClick('btnSelectUpPortsOnly', () => {
    document.querySelectorAll('#portsSelectTbody tr').forEach(tr => {
      const chk = tr.querySelector('.port-monitored-chk');
      if (chk) {
        chk.checked = (tr.dataset.status === 'up');
      }
    });
  });

  // Add NAS Folder row
  bindClick('btnAddNasFolder', () => {
    addNasFolderRow({ name: '/volume1/share', size_gb: 2000, access_group: 'Engineers', desc: 'Tài liệu thiết kế' });
  });

  // Add NAS User row
  bindClick('btnAddNasUser', () => {
    addNasUserRow({ username: 'user_' + Math.floor(Math.random() * 100), full_name: 'Kỹ sư mới', role: 'Read/Write', status: 'Active' });
  });

  // Delete device
  bindClick('btnDeleteDevice', async () => {
    const id = document.getElementById('editDevId').value;
    const name = document.getElementById('editDevName').value;
    if (!id) return;

    let confirmMsg = `Bạn có chắc chắn muốn xóa thiết bị "${name || id}" khỏi sơ đồ mạng nhà máy?`;
    if (id === 'core' || (state.topology && state.topology.core_switch && state.topology.core_switch.id === id)) {
      confirmMsg = `⚠️ CẢNH BÁO XÓA SWITCH CORE:\n\nBạn đang thực hiện xóa thiết bị Switch Core lõi (${name || 'SW-CORE-C9300'}).\n\nCác thiết bị và switch nhánh đang nối vào Switch Core sẽ tự động chuyển liên kết lên Tường Lửa Firewall (hoặc trạng thái độc lập).\n\nBạn có chắc chắn muốn xóa thiết bị này?`;
    } else if (id === 'fw' || (state.topology && state.topology.firewall && state.topology.firewall.id === id)) {
      confirmMsg = `⚠️ CẢNH BÁO XÓA TƯỜNG LỬA:\n\nBạn đang thực hiện xóa Tường Lửa chính (${name || 'Firewall'}).\n\nBạn có chắc chắn muốn xóa thiết bị này?`;
    }

    if (confirm(confirmMsg)) {
      try {
        const res = await fetch('/api/device/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        const d = await res.json();
        if (d.success) {
          modal.classList.remove('open');
          const drawer = document.getElementById('deviceDrawer');
          if (drawer) drawer.classList.remove('open');
          await loadTopology();
          showToast(d.message || `Đã xóa thiết bị "${name || id}" thành công!`);
        } else {
          alert('Lỗi: ' + (d.error || 'Không thể xóa'));
        }
      } catch (e) {
        alert('Lỗi kết nối khi xóa: ' + e.message);
      }
    }
  });

  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      await saveDeviceForm();
    };
  }
}

function handleDeviceTypeChange(type) {
  const nvrSec = document.getElementById('sectionNvrConfig');
  const nasSec = document.getElementById('sectionNasConfig');
  const swSec = document.getElementById('sectionSwitchConfig');
  if (nvrSec) nvrSec.style.display = type === 'nvr' ? 'block' : 'none';
  if (nasSec) nasSec.style.display = type === 'nas' ? 'block' : 'none';
  if (swSec) swSec.style.display = (type === 'switch' || type === 'core_switch') ? 'block' : 'none';

  // Hiện/ẩn các chỉ số đặc thù cho từng loại thiết bị
  const itemSessions = document.getElementById('itemSensorSessions');
  const itemStorage = document.getElementById('itemSensorStorage');
  if (itemSessions) itemSessions.style.display = (type === 'firewall') ? 'flex' : 'none';
  if (itemStorage) itemStorage.style.display = (type === 'nas' || type === 'nvr' || type === 'server') ? 'flex' : 'none';
}

function populateZoneDropdown(currentZoneId = 'mdf') {
  const select = document.getElementById('editDevZone');
  if (!select) return;
  select.innerHTML = '';
  if (!state.topology || !state.topology.zones) return;

  state.topology.zones.forEach((z) => {
    if (z.id === 'all') return;
    const opt = document.createElement('option');
    opt.value = z.id;
    opt.textContent = z.name;
    if (z.id === currentZoneId) opt.selected = true;
    select.appendChild(opt);
  });
  if (!select.value && select.options.length > 0) {
    select.selectedIndex = 0;
  }
}

function populateParentDropdown(excludeNodeId = null, currentParentId = null) {
  const select = document.getElementById('editDevParent');
  if (!select) return;
  select.innerHTML = '';
  const t = state.topology;
  if (!t) return;

  const parents = [];
  if (t.firewall && excludeNodeId !== (t.firewall.id || 'fw')) {
    parents.push({ id: t.firewall.id || 'fw', name: `${t.firewall.name} (Tường Lửa Firewall)` });
  }
  if (t.core_switch && excludeNodeId !== (t.core_switch.id || 'core')) {
    parents.push({ id: t.core_switch.id || 'core', name: `${t.core_switch.name} (Switch Lõi Core 10G)` });
  }
  (t.switches || []).forEach(sw => {
    if (sw.id !== excludeNodeId) {
      parents.push({ id: sw.id, name: `${sw.name} (${sw.model || 'Access Switch'})` });
    }
  });

  parents.push({ id: '', name: '-- Không chọn Uplink / Điểm gốc --' });

  // Xác định default parent nếu chưa có
  if (!currentParentId) {
    if (t.core_switch && excludeNodeId !== (t.core_switch.id || 'core')) {
      currentParentId = t.core_switch.id || 'core';
    } else if (t.firewall && excludeNodeId !== (t.firewall.id || 'fw')) {
      currentParentId = t.firewall.id || 'fw';
    } else {
      currentParentId = parents[0] ? parents[0].id : '';
    }
  }

  parents.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === currentParentId) opt.selected = true;
    select.appendChild(opt);
  });
}

function setEditDeviceStatusDisplay(status) {
  const displayEl = document.getElementById('editDevStatusDisplay');
  const inputEl = document.getElementById('editDevStatus');
  if (inputEl) inputEl.value = status;
  if (!displayEl) return;

  displayEl.className = 'device-live-status-pill';
  if (status === 'ok' || status === 'online') {
    displayEl.classList.add('status-ok');
    displayEl.innerHTML = `<span class="status-indicator-dot ok"></span> <span class="status-text"><i class="mdi mdi-check-circle"></i> Đang Hoạt Động (Online)</span>`;
  } else if (status === 'warn') {
    displayEl.classList.add('status-warn');
    displayEl.innerHTML = `<span class="status-indicator-dot warn"></span> <span class="status-text"><i class="mdi mdi-alert-circle"></i> Cảnh Báo (Độ Trễ Cao / Chập Chờn)</span>`;
  } else {
    displayEl.classList.add('status-bad');
    displayEl.innerHTML = `<span class="status-indicator-dot bad"></span> <span class="status-text"><i class="mdi mdi-close-circle"></i> Mất Kết Nối (Offline / Timeout)</span>`;
  }
}

function renderPortsSelectTable(ports = []) {
  const tbody = document.getElementById('portsSelectTbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!ports || ports.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-dim); padding:16px;">Chưa có dữ liệu cổng. Bấm "Kiểm tra kết nối SNMP" để đọc tự động.</td></tr>`;
    return;
  }

  ports.forEach(p => {
    const tr = document.createElement('tr');
    tr.dataset.port = p.port;
    tr.dataset.speed = p.speed || (p.speed_mbps ? p.speed_mbps + 'M' : '1000M');
    tr.dataset.status = p.status || 'down';

    const isMonitored = p.monitored !== false;
    const isUp = (p.status || '').toLowerCase() === 'up';

    tr.innerHTML = `
      <td style="text-align:center;">
        <input type="checkbox" class="port-monitored-chk" ${isMonitored ? 'checked' : ''} style="cursor:pointer; width:16px; height:16px; accent-color:var(--accent-cyan);">
      </td>
      <td style="font-weight:600; text-align:center;">${p.port}</td>
      <td class="port-name-text" style="font-family:monospace; color:var(--accent-cyan); font-weight:500;">
        ${escapeHtml(p.name || `Port ${p.port}`)}
      </td>
      <td>${escapeHtml(p.speed || (p.speed_mbps ? p.speed_mbps + ' Mbps' : '1 Gbps'))}</td>
      <td>
        <span class="status-badge ${isUp ? 'status-up' : 'status-down'}" style="padding:2px 8px; border-radius:12px; font-size:11px; font-weight:600; display:inline-flex; align-items:center; gap:4px; ${isUp ? 'background:rgba(16,185,129,0.15); color:#10b981; border:1px solid rgba(16,185,129,0.3);' : 'background:rgba(148,163,184,0.15); color:#94a3b8; border:1px solid rgba(148,163,184,0.3);'}">
          <span style="width:6px; height:6px; border-radius:50%; background:${isUp ? '#10b981' : '#94a3b8'};"></span>
          ${isUp ? 'UP (Online)' : 'DOWN'}
        </span>
      </td>
      <td>
        <input type="text" class="port-note-input" value="${escapeHtml(p.note || '')}" placeholder="Gán thiết bị/VLAN..." style="padding:4px 8px; font-size:12px; width:100%; border-radius:4px; border:1px solid var(--border-color); background:rgba(0,0,0,0.2); color:var(--text-main);">
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openCreateDeviceModal() {
  const modal = document.getElementById('deviceEditModal');
  const titleEl = document.getElementById('deviceModalTitle');
  const delBtn = document.getElementById('btnDeleteDevice');
  const testRes = document.getElementById('snmpTestResult');

  if (titleEl) titleEl.innerHTML = '<i class="mdi mdi-plus-box"></i> THÊM THIẾT BỊ MỚI VÀO SƠ ĐỒ';
  if (delBtn) delBtn.style.display = 'none';
  if (testRes) testRes.style.display = 'none';

  const newId = 'dev_' + Date.now().toString(36);
  document.getElementById('editDevId').value = newId;
  document.getElementById('editDevName').value = '';
  document.getElementById('editDevType').value = 'switch';
  document.getElementById('editDevIp').value = '192.168.10.';
  document.getElementById('editDevVendor').value = '';
  document.getElementById('editDevModel').value = '';
  setEditDeviceStatusDisplay('bad');
  document.getElementById('editDevSnmpCommunity').value = 'public';
  document.getElementById('editDevParentPort').value = 'Te1/0/5';
  document.getElementById('editDevChildPort').value = 'Gi1/0/24';

  populateZoneDropdown('mdf');
  populateParentDropdown(newId);
  handleDeviceTypeChange('switch');

  // Khi thêm mới thiết bị: Ban đầu chưa có dữ liệu cảm biến & cổng mạng thực tế
  // Hiển thị banner hướng dẫn bấm nút "Kiểm Tra Kết Nối SNMP" để quét tự động
  const waitBox = document.getElementById('snmpSensorsWaitingBox');
  const contentBox = document.getElementById('snmpSensorsContentBox');
  if (waitBox) waitBox.style.display = 'flex';
  if (contentBox) contentBox.style.display = 'none';

  renderPortsSelectTable([]);

  const fTbody = document.getElementById('nasFoldersTbody');
  const uTbody = document.getElementById('nasUsersTbody');
  if (fTbody) fTbody.innerHTML = '';
  if (uTbody) uTbody.innerHTML = '';

  if (modal) modal.classList.add('open');
}

function openEditDeviceModal(nodeId) {
  const dev = findDevice(nodeId);
  if (!dev) return;

  const modal = document.getElementById('deviceEditModal');
  const titleEl = document.getElementById('deviceModalTitle');
  const delBtn = document.getElementById('btnDeleteDevice');
  const testRes = document.getElementById('snmpTestResult');

  if (titleEl) titleEl.innerHTML = `<i class="mdi mdi-pencil-box"></i> CẤU HÌNH THIẾT BỊ: ${dev.name}`;
  // CHO PHÉP XÓA BẤT KỲ THIẾT BỊ NÀO (KỂ CẢ SWITCH CORE VÀ FIREWALL)
  if (delBtn) delBtn.style.display = 'inline-block';
  if (testRes) testRes.style.display = 'none';

  document.getElementById('editDevId').value = dev.id;
  document.getElementById('editDevName').value = dev.name;
  let currentType = dev.type;
  if (nodeId === 'core' || (state.topology && state.topology.core_switch && state.topology.core_switch.id === nodeId)) {
    currentType = 'core_switch';
  } else if (nodeId === 'fw' || (state.topology && state.topology.firewall && state.topology.firewall.id === nodeId)) {
    currentType = 'firewall';
  } else if (!currentType) {
    currentType = 'switch';
  }

  document.getElementById('editDevType').value = currentType;
  document.getElementById('editDevIp').value = dev.ip || '';
  document.getElementById('editDevVendor').value = dev.vendor || '';
  document.getElementById('editDevModel').value = dev.model || '';
  setEditDeviceStatusDisplay(dev.status || 'bad');
  document.getElementById('editDevParentPort').value = dev.parent_port || '';
  document.getElementById('editDevChildPort').value = dev.child_port || '';

  populateZoneDropdown(dev.zone || 'mdf');
  populateParentDropdown(nodeId, dev.parent);

  const snmp = dev.snmp || { version: '2c', community: 'public', port: 161 };
  document.getElementById('editDevSnmpCommunity').value = snmp.community || 'public';
  document.getElementById('editDevSnmpVer').value = snmp.version || '2c';
  document.getElementById('editDevSnmpPort').value = snmp.port || 161;

  handleDeviceTypeChange(currentType);

  // Kiểm tra thiết bị đã có danh sách cổng mạng hoặc cảm biến đã cấu hình hay chưa
  const editWaitBox = document.getElementById('snmpSensorsWaitingBox');
  const editContentBox = document.getElementById('snmpSensorsContentBox');
  const hasConfiguredPorts = Array.isArray(dev.ports) && dev.ports.length > 0;
  const hasConfiguredSensors = Boolean(dev.monitored_sensors);

  if (hasConfiguredPorts || hasConfiguredSensors) {
    if (editWaitBox) editWaitBox.style.display = 'none';
    if (editContentBox) editContentBox.style.display = 'block';

    // Nạp trạng thái tùy chọn giám sát cảm biến đã lưu
    const ms = dev.monitored_sensors || {};
    document.getElementById('chkSensorCpu').checked = ms.cpu !== undefined ? !!ms.cpu : true;
    document.getElementById('chkSensorRam').checked = ms.ram !== undefined ? !!ms.ram : true;
    document.getElementById('chkSensorTemp').checked = ms.temp !== undefined ? !!ms.temp : true;
    document.getElementById('chkSensorUptime').checked = ms.uptime !== undefined ? !!ms.uptime : true;
    document.getElementById('chkSensorSessions').checked = ms.sessions !== undefined ? !!ms.sessions : (currentType === 'firewall');
    document.getElementById('chkSensorStorage').checked = ms.storage !== undefined ? !!ms.storage : (currentType === 'nas' || currentType === 'nvr');

    const hintCpu = document.getElementById('hintSensorCpu');
    if (hintCpu) hintCpu.innerHTML = dev.cpu_percent !== undefined ? `Giá trị gần nhất: ${dev.cpu_percent}%` : 'Cisco / SonicWall / Fortinet / HostResources';
    const hintRam = document.getElementById('hintSensorRam');
    if (hintRam) hintRam.innerHTML = dev.ram_percent !== undefined ? `Giá trị gần nhất: ${dev.ram_percent}%` : 'Physical & Virtual Memory MIB';
    const hintTemp = document.getElementById('hintSensorTemp');
    if (hintTemp) hintTemp.innerHTML = dev.temp_c !== undefined ? `Giá trị gần nhất: ${dev.temp_c}°C` : 'Cisco EnvMon / Synology Temp MIB';

    // Nạp danh sách các cổng mạng đã lưu
    renderPortsSelectTable(dev.ports || []);
  } else {
    // Thiết bị chưa có dữ liệu SNMP: hiển thị banner hướng dẫn bấm nút "Kiểm Tra Kết Nối SNMP"
    if (editWaitBox) editWaitBox.style.display = 'flex';
    if (editContentBox) editContentBox.style.display = 'none';
    renderPortsSelectTable([]);
  }

  // Fill NVR fields
  if (currentType === 'nvr') {
    const nd = dev.nvr_details || {};
    document.getElementById('nvrTotalChannels').value = nd.total_channels || 64;
    document.getElementById('nvrActiveChannels').value = nd.active_channels || 48;
    document.getElementById('nvrRetentionDays').value = nd.retention_target_days || 30;
    document.getElementById('nvrStorageTotal').value = nd.storage_total_tb || 32;
    document.getElementById('nvrStorageUsed').value = nd.storage_used_tb || 24;
    document.getElementById('nvrCodec').value = nd.codec || 'H.265+';
  }

  // Fill NAS fields
  if (currentType === 'nas') {
    const nas = dev.nas_details || {};
    document.getElementById('nasStorageTotal').value = nas.storage_total_tb || 24;
    document.getElementById('nasStorageUsed').value = nas.storage_used_tb || 20;
    document.getElementById('nasRaidType').value = nas.raid_type || 'RAID 5';

    const fTbody = document.getElementById('nasFoldersTbody');
    if (fTbody) {
      fTbody.innerHTML = '';
      (nas.shared_folders || []).forEach(addNasFolderRow);
    }

    const uTbody = document.getElementById('nasUsersTbody');
    if (uTbody) {
      uTbody.innerHTML = '';
      (nas.user_accounts || []).forEach(addNasUserRow);
    }
  }

  // Fill Switch fields
  if (currentType === 'switch') {
    const poeTotal = document.getElementById('switchPoeTotal');
    const poeUsed = document.getElementById('switchPoeUsed');
    const portsCount = document.getElementById('switchPortsCount');
    if (poeTotal) poeTotal.value = dev.poe_total_watts || 370;
    if (poeUsed) poeUsed.value = dev.poe_used_watts || 0;
    if (portsCount) portsCount.value = (dev.ports && dev.ports.length) || 24;
  }

  if (modal) modal.classList.add('open');
}

function addNasFolderRow(f = {}) {
  const tbody = document.getElementById('nasFoldersTbody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="f-name" value="${f.name || '/volume1/share'}"></td>
    <td><input type="number" class="f-size" value="${f.size_gb || 1000}"></td>
    <td><input type="text" class="f-access" value="${f.access_group || 'All'}"></td>
    <td><input type="text" class="f-desc" value="${f.desc || ''}"></td>
    <td><button type="button" class="btn-del-row" onclick="this.closest('tr').remove()"><i class="mdi mdi-delete"></i></button></td>
  `;
  tbody.appendChild(tr);
}

function addNasUserRow(u = {}) {
  const tbody = document.getElementById('nasUsersTbody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="u-name" value="${u.username || 'user'}"></td>
    <td><input type="text" class="u-fullname" value="${u.full_name || ''}"></td>
    <td><input type="text" class="u-role" value="${u.role || 'User'}"></td>
    <td>
      <select class="u-status">
        <option value="Active" ${u.status === 'Active' ? 'selected' : ''}>Active</option>
        <option value="Disabled" ${u.status === 'Disabled' ? 'selected' : ''}>Disabled</option>
      </select>
    </td>
    <td><button type="button" class="btn-del-row" onclick="this.closest('tr').remove()"><i class="mdi mdi-delete"></i></button></td>
  `;
  tbody.appendChild(tr);
}

async function saveDeviceForm() {
  const id = document.getElementById('editDevId').value.trim();
  const name = document.getElementById('editDevName').value.trim();
  const type = document.getElementById('editDevType').value;
  const ip = document.getElementById('editDevIp').value.trim();
  const zone = document.getElementById('editDevZone').value;
  const status = document.getElementById('editDevStatus').value;
  const vendor = document.getElementById('editDevVendor').value.trim();
  const model = document.getElementById('editDevModel').value.trim();
  const parent = document.getElementById('editDevParent').value;
  const parent_port = document.getElementById('editDevParentPort').value.trim();
  const child_port = document.getElementById('editDevChildPort').value.trim();

  if (!id || !name || !ip) {
    alert('Vui lòng điền đầy đủ Tên thiết bị và Địa chỉ IP!');
    return;
  }

  const snmp = {
    community: document.getElementById('editDevSnmpCommunity').value.trim() || 'public',
    version: document.getElementById('editDevSnmpVer').value || '2c',
    port: Number(document.getElementById('editDevSnmpPort').value) || 161
  };

  const existingDev = findDevice(id);
  const contentBox = document.getElementById('snmpSensorsContentBox');
  const isContentVisible = contentBox && contentBox.style.display !== 'none';

  let monitored_sensors = existingDev ? existingDev.monitored_sensors : null;
  let ports = existingDev ? existingDev.ports : null;

  if (isContentVisible) {
    monitored_sensors = {
      cpu: document.getElementById('chkSensorCpu') ? document.getElementById('chkSensorCpu').checked : true,
      ram: document.getElementById('chkSensorRam') ? document.getElementById('chkSensorRam').checked : true,
      temp: document.getElementById('chkSensorTemp') ? document.getElementById('chkSensorTemp').checked : true,
      uptime: document.getElementById('chkSensorUptime') ? document.getElementById('chkSensorUptime').checked : true,
      sessions: document.getElementById('chkSensorSessions') ? document.getElementById('chkSensorSessions').checked : false,
      storage: document.getElementById('chkSensorStorage') ? document.getElementById('chkSensorStorage').checked : false
    };

    const portRows = document.querySelectorAll('#portsSelectTbody tr');
    if (portRows.length > 0) {
      ports = [];
      portRows.forEach(tr => {
        const portNum = Number(tr.dataset.port);
        if (!portNum) return;
        const chk = tr.querySelector('.port-monitored-chk');
        const nameEl = tr.querySelector('.port-name-text');
        const noteEl = tr.querySelector('.port-note-input');
        ports.push({
          port: portNum,
          name: nameEl ? nameEl.textContent.trim() : `Port ${portNum}`,
          monitored: chk ? chk.checked : true,
          speed: tr.dataset.speed || '1000M',
          status: tr.dataset.status || 'down',
          note: noteEl ? noteEl.value.trim() : ''
        });
      });
    }
  }

  const payload = {
    id, name, type, ip, zone, status, vendor, model, parent, parent_port, child_port, snmp
  };
  if (monitored_sensors) payload.monitored_sensors = monitored_sensors;
  if (ports && ports.length > 0) payload.ports = ports;

  if (type === 'nvr') {
    payload.nvr_details = {
      total_channels: Number(document.getElementById('nvrTotalChannels').value) || 64,
      active_channels: Number(document.getElementById('nvrActiveChannels').value) || 48,
      retention_target_days: Number(document.getElementById('nvrRetentionDays').value) || 30,
      storage_total_tb: Number(document.getElementById('nvrStorageTotal').value) || 32,
      storage_used_tb: Number(document.getElementById('nvrStorageUsed').value) || 24,
      codec: document.getElementById('nvrCodec').value || 'H.265+'
    };
  }

  if (type === 'nas') {
    const folders = [];
    document.querySelectorAll('#nasFoldersTbody tr').forEach(tr => {
      folders.push({
        name: tr.querySelector('.f-name').value,
        size_gb: Number(tr.querySelector('.f-size').value) || 0,
        access_group: tr.querySelector('.f-access').value,
        desc: tr.querySelector('.f-desc').value
      });
    });

    const users = [];
    document.querySelectorAll('#nasUsersTbody tr').forEach(tr => {
      users.push({
        username: tr.querySelector('.u-name').value,
        full_name: tr.querySelector('.u-fullname').value,
        role: tr.querySelector('.u-role').value,
        status: tr.querySelector('.u-status').value
      });
    });

    payload.nas_details = {
      storage_total_tb: Number(document.getElementById('nasStorageTotal').value) || 24,
      storage_used_tb: Number(document.getElementById('nasStorageUsed').value) || 20,
      raid_type: document.getElementById('nasRaidType').value || 'RAID 5',
      shared_folders: folders,
      user_accounts: users
    };
  }

  if (type === 'switch' || type === 'core_switch') {
    payload.poe_total_watts = Number(document.getElementById('switchPoeTotal').value) || 370;
    payload.poe_used_watts = Number(document.getElementById('switchPoeUsed').value) || 0;
    payload.ports_count = Number(document.getElementById('switchPortsCount').value) || 24;
  }

  try {
    const res = await fetch('/api/device/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (d.success) {
      document.getElementById('deviceEditModal').classList.remove('open');
      await loadTopology();
      const drawer = document.getElementById('deviceDrawer');
      if (drawer && drawer.classList.contains('open')) {
        openDeviceDrawer(id);
      }
      showToast(d.message || `Đã lưu thiết bị "${name}" thành công!`);
    } else {
      alert(d.error || 'Lỗi lưu thiết bị');
    }
  } catch (err) {
    alert('Lỗi: ' + err.message);
  }
}

// ============================================================================
// NETWORK INTERFACES & REAL SUBNET SCANNER
// ============================================================================
async function loadNetworkInterfaces() {
  try {
    const res = await fetch('/api/network-interfaces');
    const data = await res.json();
    if (data.success && data.interfaces) {
      state.networkInterfaces = data.interfaces;
      renderNetworkInterfacesDropdown();
    }
  } catch (err) {
    console.error('Lỗi nạp card mạng:', err);
  }
}

function renderNetworkInterfacesDropdown() {
  const select = document.getElementById('scanNicSelect');
  if (!select) return;
  select.innerHTML = '';

  state.networkInterfaces.forEach((nic, idx) => {
    const opt = document.createElement('option');
    opt.value = nic.name;
    const tag = nic.isInternal ? '[Loopback]' : nic.isPreferred ? '[Ưu tiên]' : '';
    opt.textContent = `${nic.name}: ${nic.ip} (${nic.cidr}) ${tag}`;
    if (idx === 0) opt.selected = true;
    select.appendChild(opt);
  });

  if (state.networkInterfaces.length > 0) {
    onNetworkInterfaceSelected(state.networkInterfaces[0]);
  }
}

function onNetworkInterfaceSelected(nic) {
  if (!nic) return;
  const infoEl = document.getElementById('scanNicInfo');
  if (infoEl) {
    infoEl.textContent = `IP: ${nic.ip} | Netmask: ${nic.netmask} | MAC: ${nic.mac} | Subnet: ${nic.cidr}`;
  }
  const startEl = document.getElementById('scanStartIp');
  const endEl = document.getElementById('scanEndIp');
  if (startEl && nic.startIp) startEl.value = nic.startIp;
  if (endEl && nic.endIp) {
    const parts = nic.startIp.split('.');
    endEl.value = `${parts[0]}.${parts[1]}.${parts[2]}.30`;
  }
}

function initSubnetScannerEvents() {
  const scanModal = document.getElementById('scanModal');
  bindClick('btnScanModal', () => {
    loadNetworkInterfaces();
    if (scanModal) scanModal.classList.add('open');
  });
  bindClick('btnScanClose', () => {
    if (scanModal) scanModal.classList.remove('open');
  });

  bindChange('scanNicSelect', (e) => {
    const selected = state.networkInterfaces.find(n => n.name === e.target.value);
    onNetworkInterfaceSelected(selected);
  });

  bindClick('btnRefreshNics', () => {
    loadNetworkInterfaces();
    showToast('Đã làm mới danh sách card mạng');
  });

  bindClick('btnStartScan', async () => {
    const mode = document.getElementById('scanModeSelect').value;
    const startIp = document.getElementById('scanStartIp').value.trim();
    const endIp = document.getElementById('scanEndIp').value.trim();
    const community = document.getElementById('scanCommunityInput').value.trim();

    const ports = [];
    if (document.getElementById('scanPortSnmp').checked) ports.push(161);
    if (document.getElementById('scanPortWeb').checked) ports.push(80, 443);
    if (document.getElementById('scanPortNvr').checked) ports.push(554, 37777, 8000);
    if (document.getElementById('scanPortNas').checked) ports.push(445, 5000);
    if (document.getElementById('scanPortSsh').checked) ports.push(22);

    const progressBox = document.getElementById('scanProgressBox');
    const progressBar = document.getElementById('scanProgressBar');
    const progressStatus = document.getElementById('scanProgressStatus');
    const progressPercent = document.getElementById('scanProgressPercent');
    const resultsBox = document.getElementById('scanResults');
    const tbody = document.getElementById('scanResultsTbody');
    const countEl = document.getElementById('scanFoundCount');
    const btnStart = document.getElementById('btnStartScan');
    const btnCancel = document.getElementById('btnCancelScan');

    if (progressBox) progressBox.style.display = 'block';
    if (resultsBox) resultsBox.style.display = 'block';
    if (tbody) tbody.innerHTML = '';
    if (countEl) countEl.textContent = '0';
    if (progressBar) progressBar.style.width = '5%';
    if (progressPercent) progressPercent.textContent = '5%';
    if (progressStatus) progressStatus.textContent = `Đang kết nối thăm dò dải IP ${startIp} -> ${endIp}...`;

    if (btnStart) btnStart.style.display = 'none';
    if (btnCancel) btnCancel.style.display = 'inline-flex';
    state.isScanning = true;

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, startIp, endIp, community, ports })
      });
      const data = await res.json();

      if (progressBar) progressBar.style.width = '100%';
      if (progressPercent) progressPercent.textContent = '100%';
      if (progressStatus) progressStatus.textContent = `Hoàn tất! Tìm thấy ${data.count || 0} thiết bị đang hoạt động.`;
      if (countEl) countEl.textContent = data.count || 0;

      if (data.devices && data.devices.length && tbody) {
        tbody.innerHTML = '';
        data.devices.forEach(d => renderScannedDeviceRow(d));
      } else if (tbody) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:16px; color:var(--text-dim);">Không tìm thấy thiết bị nào phản hồi trong dải IP này.</td></tr>';
      }
    } catch (err) {
      if (progressStatus) progressStatus.textContent = 'Lỗi quét mạng: ' + err.message;
    } finally {
      if (btnStart) btnStart.style.display = 'inline-flex';
      if (btnCancel) btnCancel.style.display = 'none';
      state.isScanning = false;
    }
  });

  bindClick('btnCancelScan', async () => {
    try {
      await fetch('/api/scan/cancel', { method: 'POST' });
      const statusEl = document.getElementById('scanProgressStatus');
      if (statusEl) statusEl.textContent = 'Đã hủy quét mạng.';
      const btnStart = document.getElementById('btnStartScan');
      const btnCancel = document.getElementById('btnCancelScan');
      if (btnStart) btnStart.style.display = 'inline-flex';
      if (btnCancel) btnCancel.style.display = 'none';
      state.isScanning = false;
    } catch (e) {}
  });
}

function handleScanProgressSSE(prog) {
  if (!state.isScanning || !prog) return;
  const bar = document.getElementById('scanProgressBar');
  const txt = document.getElementById('scanProgressStatus');
  const pct = document.getElementById('scanProgressPercent');
  if (bar) bar.style.width = `${prog.percent}%`;
  if (pct) pct.textContent = `${prog.percent}%`;
  if (txt) txt.textContent = `Đang quét dải IP... (${prog.scanned}/${prog.total})`;
}

function handleScanDeviceFoundSSE(device, prog) {
  if (!device) return;
  const tbody = document.getElementById('scanResultsTbody');
  const countEl = document.getElementById('scanFoundCount');
  if (tbody) {
    renderScannedDeviceRow(device);
    const count = tbody.querySelectorAll('tr').length;
    if (countEl) countEl.textContent = count;
  }
  handleScanProgressSSE(prog);
}

function renderScannedDeviceRow(d) {
  const tbody = document.getElementById('scanResultsTbody');
  if (!tbody) return;

  if (tbody.querySelector(`tr[data-scan-ip="${d.ip}"]`)) return;

  const tr = document.createElement('tr');
  tr.dataset.scanIp = d.ip;

  const portBadges = (d.open_ports || []).map(p => {
    let cls = '';
    if (p === 161) cls = 'snmp';
    else if (p === 554 || p === 37777 || p === 8000) cls = 'camera';
    else if (p === 445 || p === 5000) cls = 'storage';
    return `<span class="port-pill ${cls}">Port ${p}</span>`;
  }).join(' ');

  const iconMap = {
    firewall: 'mdi-shield-lock',
    switch: 'mdi-lan-connect',
    nvr: 'mdi-cctv',
    nas: 'mdi-server',
    controller: 'mdi-access-point-network',
    ups: 'mdi-battery-charging',
    server: 'mdi-server-network'
  };

  tr.innerHTML = `
    <td><strong style="color:var(--neon-cyan); font-family:var(--font-mono);">${d.ip}</strong></td>
    <td><span class="device-type-badge ${d.type}"><i class="mdi ${iconMap[d.type] || 'mdi-server'}"></i> ${d.type}</span></td>
    <td>
      <strong style="color:#f8fafc;">${d.vendor || ''} ${d.model || ''}</strong><br>
      <small style="color:var(--text-dim); font-size:11px;">${d.sysDescr || 'SNMP Responder'}</small>
    </td>
    <td>${portBadges || '<span style="color:var(--text-dim);">–</span>'}</td>
    <td><span style="color:#a7f3d0; font-family:var(--font-mono);">${d.latency_ms || 2} ms</span></td>
    <td>
      <button type="button" class="btn-primary" style="padding:4px 10px; font-size:11px;" onclick='quickAddScannedDevice(${JSON.stringify(d)})'>
        <i class="mdi mdi-plus"></i> Thêm Vào Topo
      </button>
    </td>
  `;

  tbody.appendChild(tr);
}

window.quickAddScannedDevice = function(devData) {
  const scanModal = document.getElementById('scanModal');
  if (scanModal) scanModal.classList.remove('open');
  openCreateDeviceModal();

  document.getElementById('editDevIp').value = devData.ip;
  document.getElementById('editDevType').value = devData.type;
  document.getElementById('editDevName').value = `${devData.type.toUpperCase()}-${devData.ip.split('.').pop()}`;
  document.getElementById('editDevVendor').value = devData.vendor || '';
  document.getElementById('editDevModel').value = devData.model || '';

  handleDeviceTypeChange(devData.type);
  showToast(`Đã nạp thông tin thiết bị ${devData.ip}, hãy chọn Vị Trí Cha và bấm Lưu!`);
};

// ============================================================================
// ZONE MANAGEMENT MODAL
// ============================================================================
function initZoneModalEvents() {
  const modal = document.getElementById('zoneManageModal');

  bindClick('btnManageZones', () => {
    cancelEditZone();
    renderZonesManagementList();
    if (modal) modal.classList.add('open');
  });

  bindClick('btnZoneModalClose', () => {
    cancelEditZone();
    if (modal) modal.classList.remove('open');
  });

  bindClick('btnCancelEditZone', () => {
    cancelEditZone();
  });

  bindClick('btnAddZoneSubmit', async () => {
    const origId = document.getElementById('editZoneOrigId').value.trim();
    let id = document.getElementById('newZoneId').value.trim();
    const name = document.getElementById('newZoneName').value.trim();
    const icon = document.getElementById('newZoneIcon').value.trim() || 'mdi-domain';

    if (!name) {
      alert('Vui lòng nhập Tên khu vực / phân xưởng!');
      return;
    }

    if (!id) {
      // Tự sinh mã ID thân thiện từ tên khu vực
      id = name.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      if (!id) id = 'zone_' + Date.now().toString(36);
    }

    try {
      const res = await fetch('/api/zone/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, icon, original_id: origId })
      });
      const d = await res.json();
      if (d.success) {
        state.topology.zones = d.zones;
        renderZones();
        renderZonesManagementList();
        cancelEditZone();
        showToast(origId ? `Đã cập nhật thông tin phân xưởng "${name}"!` : `Đã thêm phân xưởng "${name}" thành công!`);
      } else {
        alert(d.error || 'Lỗi lưu thông tin khu vực');
      }
    } catch (e) {
      alert('Lỗi kết nối: ' + e.message);
    }
  });
}

function renderZonesManagementList() {
  const tbody = document.getElementById('zonesListTbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!state.topology || !state.topology.zones) return;

  const t = state.topology;
  const countInZone = (zid) => {
    if (zid === 'all') {
      return (t.switches || []).length + (t.infrastructure_nodes || []).length + (t.firewall ? 1 : 0) + (t.core_switch ? 1 : 0);
    }
    let cnt = 0;
    (t.switches || []).forEach(s => { if (s.zone === zid) cnt++; });
    (t.infrastructure_nodes || []).forEach(n => { if (n.zone === zid) cnt++; });
    if (t.firewall && t.firewall.zone === zid) cnt++;
    if (t.core_switch && t.core_switch.zone === zid) cnt++;
    return cnt;
  };

  t.zones.forEach((z) => {
    const tr = document.createElement('tr');
    const isFilterAll = (z.id === 'all');
    tr.innerHTML = `
      <td style="text-align:center;"><i class="mdi ${z.icon || 'mdi-domain'}" style="font-size:20px; color:var(--accent-cyan);"></i></td>
      <td><strong>${escapeHtml(z.name)}</strong></td>
      <td><code>${escapeHtml(z.id)}</code></td>
      <td>${countInZone(z.id)} thiết bị</td>
      <td>
        ${!isFilterAll ? `
          <button type="button" class="btn-xs btn-edit-row" onclick="startEditZone('${escapeHtml(z.id)}')" title="Chỉnh sửa tên và cấu hình khu vực này">
            <i class="mdi mdi-pencil"></i> Sửa
          </button>
          <button type="button" class="btn-xs btn-del-row" onclick="deleteZone('${escapeHtml(z.id)}')" title="Xóa khu vực này">
            <i class="mdi mdi-delete"></i> Xóa
          </button>
        ` : '<span style="color:var(--text-dim); font-size:11px;">Mặc định (Bộ lọc)</span>'}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.startEditZone = function(zoneId) {
  const z = (state.topology && state.topology.zones || []).find(item => item.id === zoneId);
  if (!z) return;

  const origIdEl = document.getElementById('editZoneOrigId');
  const nameEl = document.getElementById('newZoneName');
  const idEl = document.getElementById('newZoneId');
  const iconEl = document.getElementById('newZoneIcon');
  const titleEl = document.getElementById('zoneFormTitle');
  const btnSubmit = document.getElementById('btnAddZoneSubmit');
  const btnCancel = document.getElementById('btnCancelEditZone');

  if (origIdEl) origIdEl.value = z.id;
  if (nameEl) nameEl.value = z.name || '';
  if (idEl) idEl.value = z.id || '';
  if (iconEl) {
    iconEl.value = z.icon || 'mdi-server-network';
    if (!iconEl.value) {
      let found = false;
      for (let opt of iconEl.options) {
        if (opt.value === z.icon) { found = true; break; }
      }
      if (!found && z.icon) {
        const customOpt = new Option(z.icon, z.icon, true, true);
        iconEl.add(customOpt);
      }
    }
  }

  if (titleEl) titleEl.innerHTML = `<i class="mdi mdi-pencil"></i> Đang chỉnh sửa phân xưởng: <strong>${escapeHtml(z.name)}</strong>`;
  if (btnSubmit) {
    btnSubmit.innerHTML = `<i class="mdi mdi-content-save"></i> Cập Nhật`;
    btnSubmit.classList.remove('btn-primary');
    btnSubmit.classList.add('btn-warning');
  }
  if (btnCancel) btnCancel.style.display = 'inline-block';
  if (nameEl) nameEl.focus();
};

window.cancelEditZone = function() {
  const origIdEl = document.getElementById('editZoneOrigId');
  const nameEl = document.getElementById('newZoneName');
  const idEl = document.getElementById('newZoneId');
  const titleEl = document.getElementById('zoneFormTitle');
  const btnSubmit = document.getElementById('btnAddZoneSubmit');
  const btnCancel = document.getElementById('btnCancelEditZone');

  if (origIdEl) origIdEl.value = '';
  if (nameEl) nameEl.value = '';
  if (idEl) idEl.value = '';

  if (titleEl) titleEl.innerHTML = `<i class="mdi mdi-plus-box"></i> Thêm Phân Xưởng / Khu Vực Mới:`;
  if (btnSubmit) {
    btnSubmit.innerHTML = `<i class="mdi mdi-plus"></i> Thêm Khu Vực`;
    btnSubmit.classList.add('btn-primary');
    btnSubmit.classList.remove('btn-warning');
  }
  if (btnCancel) btnCancel.style.display = 'none';
};

window.deleteZone = async function(id) {
  if (id === 'all') {
    alert('Không thể xóa bộ lọc "Tất cả"!');
    return;
  }
  const z = (state.topology && state.topology.zones || []).find(item => item.id === id);
  const zName = z ? z.name : id;
  if (confirm(`Bạn có chắc muốn xóa phân xưởng "${zName}" (${id})?\nCác thiết bị trong khu vực này sẽ tự động chuyển sang phân xưởng còn lại.`)) {
    try {
      const res = await fetch('/api/zone/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const d = await res.json();
      if (d.success) {
        state.topology.zones = d.zones;
        renderZones();
        renderZonesManagementList();
        cancelEditZone();
        showToast(`Đã xóa phân xưởng "${zName}"!`);
      } else {
        alert(d.error || 'Lỗi khi xóa phân xưởng');
      }
    } catch (e) {
      alert('Lỗi: ' + e.message);
    }
  }
};

// ============================================================================
// SYSTEM SETTINGS & TELEGRAM ALERTS MODAL
// ============================================================================
function initSettingsModalEvents() {
  const modal = document.getElementById('settingsModal');

  // Open settings modal (ID: btnSettingsModal in HTML)
  bindClick('btnSettingsModal', () => {
    populateSettingsForm();
    if (modal) modal.classList.add('open');
  });

  // Close settings modal (ID: btnSettingsModalClose in HTML)
  bindClick('btnSettingsModalClose', () => {
    if (modal) modal.classList.remove('open');
  });

  // Tab switching (tabBtnFactory, tabBtnTelegram)
  const tabFactory = document.getElementById('tabBtnFactory');
  const tabTelegram = document.getElementById('tabBtnTelegram');
  const paneFactory = document.getElementById('tabContentFactory');
  const paneTelegram = document.getElementById('tabContentTelegram');

  if (tabFactory && tabTelegram) {
    tabFactory.onclick = () => {
      tabFactory.classList.add('active');
      tabTelegram.classList.remove('active');
      if (paneFactory) paneFactory.style.display = 'block';
      if (paneTelegram) paneTelegram.style.display = 'none';
    };

    tabTelegram.onclick = () => {
      tabTelegram.classList.add('active');
      tabFactory.classList.remove('active');
      if (paneFactory) paneFactory.style.display = 'none';
      if (paneTelegram) paneTelegram.style.display = 'block';
    };
  }

  // Save General Factory Settings (ID: btnSaveFactorySettings in HTML)
  bindClick('btnSaveFactorySettings', async () => {
    const name = document.getElementById('cfgFactoryName').value.trim();
    const location = document.getElementById('cfgFactoryLocation').value.trim();
    const poll = document.getElementById('cfgPollInterval').value;
    const threshold = document.getElementById('cfgActiveThreshold').value;

    try {
      const res = await fetch('/api/settings/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          factory: { name, location },
          settings: { poll_interval_sec: poll, active_threshold_bps: threshold }
        })
      });
      const d = await res.json();
      if (d.success) {
        state.topology.factory = d.factory;
        state.topology.settings = d.settings;
        setupHeader();
        if (modal) modal.classList.remove('open');
        showToast('Đã cập nhật thông tin nhà máy thành công!');
      }
    } catch (e) {
      alert('Lỗi lưu cài đặt: ' + e.message);
    }
  });

  // Save Telegram Settings (ID: btnSaveTelegramSettings in HTML)
  bindClick('btnSaveTelegramSettings', async () => {
    const enabled = document.getElementById('cfgTgEnabled').checked;
    const bot_token = document.getElementById('cfgTgToken').value.trim();
    const chat_id = document.getElementById('cfgTgChatId').value.trim();
    const alert_on_offline = document.getElementById('cfgTgOffline').checked;
    const alert_on_high_traffic = document.getElementById('cfgTgTraffic').checked;
    const alert_on_storage = document.getElementById('cfgTgStorage').checked;

    try {
      const res = await fetch('/api/telegram/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, bot_token, chat_id, alert_on_offline, alert_on_high_traffic, alert_on_storage })
      });
      const d = await res.json();
      if (d.success) {
        state.topology.settings.telegram = d.telegram;
        if (modal) modal.classList.remove('open');
        showToast('Đã lưu cấu hình cảnh báo Telegram!');
      }
    } catch (e) {
      alert('Lỗi lưu Telegram: ' + e.message);
    }
  });

  // Test Telegram Message (ID: btnTestTelegram in HTML)
  bindClick('btnTestTelegram', async () => {
    const bot_token = document.getElementById('cfgTgToken').value.trim();
    const chat_id = document.getElementById('cfgTgChatId').value.trim();

    if (!bot_token || !chat_id) {
      alert('Vui lòng điền Bot Token và Chat ID trước khi gửi tin thử nghiệm!');
      return;
    }

    const btn = document.getElementById('btnTestTelegram');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="mdi mdi-loading mdi-spin"></i> Đang gửi tin...';
    }

    try {
      const res = await fetch('/api/telegram/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_token, chat_id })
      });
      const d = await res.json();
      if (d.success) {
        showToast('Gửi tin nhắn thử nghiệm Telegram thành công!');
      } else {
        alert(d.error || 'Lỗi gửi tin');
      }
    } catch (e) {
      alert('Lỗi: ' + e.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="mdi mdi-send"></i> Gửi Thử Nghiệm';
      }
    }
  });
}

function populateSettingsForm() {
  if (!state.topology) return;
  const f = state.topology.factory || {};
  const s = state.topology.settings || {};
  const tg = s.telegram || {};

  const nameEl = document.getElementById('cfgFactoryName');
  const locEl = document.getElementById('cfgFactoryLocation');
  const pollEl = document.getElementById('cfgPollInterval');
  const thresEl = document.getElementById('cfgActiveThreshold');

  if (nameEl) nameEl.value = f.name || '';
  if (locEl) locEl.value = f.location || '';
  if (pollEl) pollEl.value = s.poll_interval_sec || 3;
  if (thresEl) thresEl.value = s.active_threshold_bps || 2000;

  const enEl = document.getElementById('cfgTgEnabled');
  const tokEl = document.getElementById('cfgTgToken');
  const chatEl = document.getElementById('cfgTgChatId');
  const offEl = document.getElementById('cfgTgOffline');
  const trafEl = document.getElementById('cfgTgTraffic');
  const storEl = document.getElementById('cfgTgStorage');

  if (enEl) enEl.checked = Boolean(tg.enabled);
  if (tokEl) tokEl.value = tg.bot_token || '';
  if (chatEl) chatEl.value = tg.chat_id || '';
  if (offEl) offEl.checked = tg.alert_on_offline !== false;
  if (trafEl) trafEl.checked = tg.alert_on_high_traffic !== false;
  if (storEl) storEl.checked = tg.alert_on_storage !== false;
}

// ============================================================================
// ACTIVE ALERTS DETAILS MODAL
// ============================================================================
function initAlertsModalEvents() {
  const modal = document.getElementById('alertsDetailModal');
  const alertPill = document.getElementById('statAlertPill');

  if (alertPill) {
    alertPill.onclick = () => openAlertsModal();
  }

  bindClick('btnAlertsModalClose', () => modal && modal.classList.remove('open'));
  bindClick('btnCloseAlertsModal', () => modal && modal.classList.remove('open'));
  bindClick('btnOpenAlertsSettings', () => {
    if (modal) modal.classList.remove('open');
    const settingsBtn = document.getElementById('btnSettingsModal');
    if (settingsBtn) settingsBtn.click();
  });
}

function getActiveAlertsList() {
  const alerts = [];
  const t = state.topology;
  if (!t) return alerts;

  const allDevs = [];
  if (t.firewall) allDevs.push(t.firewall);
  if (t.core_switch) allDevs.push(t.core_switch);
  (t.switches || []).forEach(s => allDevs.push(s));
  (t.infrastructure_nodes || []).forEach(n => allDevs.push(n));
  (t.isp || []).forEach(i => allDevs.push(i));

  allDevs.forEach(dev => {
    // 1. Mất kết nối (Offline / Bad / Timeout)
    if (dev.status === 'bad' || dev.status === 'offline' || dev.status === 'down') {
      alerts.push({
        id: `alert_offline_${dev.id}`,
        deviceId: dev.id,
        deviceName: dev.name,
        deviceIp: dev.ip,
        deviceType: dev.type,
        zone: dev.zone || 'mdf',
        severity: 'critical',
        severityText: 'Mất Kết Nối (Offline)',
        title: `Mất kết nối tới thiết bị "${dev.name}"`,
        message: dev.warn_msg || `Thiết bị tại ${dev.ip || 'chưa gán IP'} không phản hồi gói tin SNMP/Ping. Kiểm tra nguồn điện hoặc cáp mạng.`,
        time: 'Đang diễn ra'
      });
    } else if (dev.status === 'warn') {
      alerts.push({
        id: `alert_warn_${dev.id}`,
        deviceId: dev.id,
        deviceName: dev.name,
        deviceIp: dev.ip,
        deviceType: dev.type,
        zone: dev.zone || 'mdf',
        severity: 'warning',
        severityText: 'Cảnh Báo (Warn)',
        title: `Cảnh báo độ trễ cao / chập chờn trên "${dev.name}"`,
        message: dev.warn_msg || `Độ trễ phản hồi (${dev.latency_ms || 0} ms) cao bất thường hoặc có dấu hiệu suy hao mạng.`,
        time: 'Đang diễn ra'
      });
    }

    // 2. Cảnh báo nhiệt độ phần cứng (> 65°C)
    if (dev.temp_c && dev.temp_c > 65) {
      alerts.push({
        id: `alert_temp_${dev.id}`,
        deviceId: dev.id,
        deviceName: dev.name,
        deviceIp: dev.ip,
        deviceType: dev.type,
        zone: dev.zone || 'mdf',
        severity: 'warning',
        severityText: 'Nhiệt Độ Cao',
        title: `Nhiệt độ phần cứng cao (${dev.temp_c}°C)`,
        message: `Thiết bị "${dev.name}" đang hoạt động ở ${dev.temp_c}°C, vượt ngưỡng an toàn (65°C). Cần kiểm tra quạt làm mát phòng máy.`,
        time: 'Đang diễn ra'
      });
    }

    // 3. Cảnh báo tải CPU (> 85%)
    if (dev.cpu && dev.cpu > 85) {
      alerts.push({
        id: `alert_cpu_${dev.id}`,
        deviceId: dev.id,
        deviceName: dev.name,
        deviceIp: dev.ip,
        deviceType: dev.type,
        zone: dev.zone || 'mdf',
        severity: 'warning',
        severityText: 'Tải CPU Cao',
        title: `Tải CPU trên thiết bị đạt ${dev.cpu}%`,
        message: `Tải CPU đang quá tải, có thể gây nghẽn băng thông hoặc trễ xử lý gói tin.`,
        time: 'Đang diễn ra'
      });
    }

    // 4. Cảnh báo dung lượng lưu trữ (> 90%)
    if (dev.type === 'nas' && dev.nas_details) {
      const tot = dev.nas_details.storage_total_tb || 0;
      const used = dev.nas_details.storage_used_tb || 0;
      if (tot > 0 && (used / tot) >= 0.9) {
        const pct = Math.round((used / tot) * 100);
        alerts.push({
          id: `alert_nas_${dev.id}`,
          deviceId: dev.id,
          deviceName: dev.name,
          deviceIp: dev.ip,
          deviceType: dev.type,
          zone: dev.zone || 'mdf',
          severity: 'warning',
          severityText: 'Sắp Hết Dung Lượng',
          title: `Dung lượng NAS sắp đầy (${pct}%)`,
          message: `Đã sử dụng ${used} TB / ${tot} TB. Cần dọn dẹp dữ liệu hoặc bổ sung ổ cứng.`,
          time: 'Đang diễn ra'
        });
      }
    } else if (dev.type === 'nvr' && dev.nvr_details) {
      const tot = dev.nvr_details.storage_total_tb || 0;
      const used = dev.nvr_details.storage_used_tb || 0;
      if (tot > 0 && (used / tot) >= 0.9) {
        const pct = Math.round((used / tot) * 100);
        alerts.push({
          id: `alert_nvr_${dev.id}`,
          deviceId: dev.id,
          deviceName: dev.name,
          deviceIp: dev.ip,
          deviceType: dev.type,
          zone: dev.zone || 'mdf',
          severity: 'warning',
          severityText: 'Sắp Hết Dung Lượng',
          title: `Đầu ghi camera NVR sắp đầy (${pct}%)`,
          message: `Dung lượng video đạt ${used} TB / ${tot} TB.`,
          time: 'Đang diễn ra'
        });
      }
    }
  });

  return alerts;
}

function openAlertsModal() {
  const modal = document.getElementById('alertsDetailModal');
  const contentEl = document.getElementById('alertsModalContent');
  if (!modal || !contentEl) return;

  const alerts = getActiveAlertsList();

  if (alerts.length === 0) {
    contentEl.innerHTML = `
      <div class="alert-empty-state">
        <i class="mdi mdi-check-decagram"></i>
        <h3>TẤT CẢ THIẾT BỊ ĐANG HOẠT ĐỘNG TỐT</h3>
        <p>Hệ thống không ghi nhận bất kỳ cảnh báo mất kết nối, suy hao đường truyền hay vượt ngưỡng nào tại thời điểm này.</p>
      </div>
    `;
  } else {
    let html = `<div class="alerts-list-container">`;
    alerts.forEach(a => {
      const isCrit = (a.severity === 'critical');
      html += `
        <div class="alert-item-card ${isCrit ? 'critical' : 'warning'}">
          <div class="alert-badge ${isCrit ? 'critical' : 'warning'}">
            <i class="mdi ${isCrit ? 'mdi-alert-octagon' : 'mdi-alert'}"></i>
            ${escapeHtml(a.severityText)}
          </div>
          <div class="alert-item-main">
            <div class="alert-item-header">
              <span class="alert-device-name">${escapeHtml(a.deviceName)}</span>
              <span class="alert-device-ip">[${escapeHtml(a.deviceIp || 'No IP')}]</span>
              <span class="alert-zone-badge">${escapeHtml(a.zone || 'Khu vực')}</span>
            </div>
            <div class="alert-item-title">${escapeHtml(a.title)}</div>
            <div class="alert-item-message">${escapeHtml(a.message)}</div>
          </div>
          <div class="alert-item-actions">
            <span class="alert-time">${escapeHtml(a.time)}</span>
            <button type="button" class="btn-xs btn-edit-row" onclick="viewAlertDevice('${escapeHtml(a.deviceId)}')">
              <i class="mdi mdi-eye"></i> Xem Thiết Bị
            </button>
          </div>
        </div>
      `;
    });
    html += `</div>`;
    contentEl.innerHTML = html;
  }

  modal.classList.add('open');
}

window.viewAlertDevice = function(deviceId) {
  const modal = document.getElementById('alertsDetailModal');
  if (modal) modal.classList.remove('open');
  if (deviceId) {
    openDeviceDrawer(deviceId);
  }
};

// ============================================================================
// TOPOLOGY TOOLBAR & ZOOM CONTROLS
// ============================================================================
function initUIControls() {
  // Theme Toggle
  bindClick('btnThemeToggle', () => {
    state.theme = state.theme === 'neon' ? 'glass' : 'neon';
    document.body.className = `theme-${state.theme}`;
    showToast(`Đã chuyển sang giao diện: ${state.theme.toUpperCase()}`);
  });

  // Flow Style Toggle
  bindClick('btnFlowToggle', () => {
    state.flowStyle = state.flowStyle === 'galaxy' ? 'dash' : 'galaxy';
    const btn = document.getElementById('btnFlowToggle');
    if (btn) btn.classList.toggle('active', state.flowStyle === 'galaxy');
    scheduleDrawLinks();
    showToast(`Hiệu ứng đường truyền: ${state.flowStyle.toUpperCase()}`);
  });

  // Reset Layout Coordinates
  bindClick('btnResetLayout', () => {
    if (confirm('Đặt lại vị trí mặc định cho toàn bộ thiết bị?')) {
      state.topology.layout = {
        isp1: { x: 60, y: 80 },
        isp2: { x: 60, y: 280 },
        fw: { x: 380, y: 170 },
        core: { x: 720, y: 170 },
        sw_a: { x: 1080, y: 70 },
        sw_b: { x: 1080, y: 220 },
        sw_kho: { x: 1080, y: 380 },
        sw_vanphong: { x: 1080, y: 540 },
        nas1: { x: 1440, y: 60 },
        nvr1: { x: 1440, y: 250 },
        wlc1: { x: 1440, y: 440 },
        ups1: { x: 1440, y: 600 }
      };
      renderTopologyNodes();
      scheduleDrawLinks();
      for (const [id, pos] of Object.entries(state.topology.layout)) {
        saveNodePosition(id, pos.x, pos.y);
      }
      showToast('Đã sắp xếp lại bố cục Topo chuẩn');
    }
  });

  bindClick('btnFullscreen', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  });

  bindClick('btnDrawerClose', () => {
    const drawer = document.getElementById('deviceDrawer');
    if (drawer) drawer.classList.remove('open');
  });

  bindClick('btnEditCurrentDevice', () => {
    if (state.currentEditingDevId) openEditDeviceModal(state.currentEditingDevId);
  });

  // Zoom Buttons
  bindClick('btnZoomIn', () => {
    state.zoom = Math.min(2.0, state.zoom * 1.15);
    const container = document.getElementById('zoomContainer');
    if (container) container.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    const lbl = document.getElementById('lblZoomLevel');
    if (lbl) lbl.textContent = `${Math.round(state.zoom * 100)}%`;
    scheduleDrawLinks();
  });

  bindClick('btnZoomOut', () => {
    state.zoom = Math.max(0.35, state.zoom * 0.85);
    const container = document.getElementById('zoomContainer');
    if (container) container.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    const lbl = document.getElementById('lblZoomLevel');
    if (lbl) lbl.textContent = `${Math.round(state.zoom * 100)}%`;
    scheduleDrawLinks();
  });

  // Fit view (ID: btnFitView in HTML)
  bindClick('btnFitView', () => {
    state.zoom = 0.85;
    state.panX = 40;
    state.panY = 30;
    const container = document.getElementById('zoomContainer');
    if (container) container.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    const lbl = document.getElementById('lblZoomLevel');
    if (lbl) lbl.textContent = '85%';
    scheduleDrawLinks();
  });
}

// ============================================================================
// WINDOW RESIZE & RUN BOOTSTRAP
// ============================================================================
window.addEventListener('resize', () => {
  scheduleDrawLinks();
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
