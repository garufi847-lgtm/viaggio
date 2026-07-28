(() => {
  'use strict';

  const STORAGE_KEY = 'talamone-trip-v1';
  const API_KEY_STORAGE = 'talamone-gmaps-key';

  const boardBody = document.getElementById('board-body');
  const dateInput = document.getElementById('trip-date');
  const timeInput = document.getElementById('trip-time');
  const toggle = document.getElementById('stop-toggle');
  const toggleOpts = toggle.querySelectorAll('.toggle-opt');
  const resetBtn = document.getElementById('reset-btn');

  const directionToggle = document.getElementById('direction-toggle');
  const directionOpts = directionToggle.querySelectorAll('.toggle-opt');
  const profileToggle = document.getElementById('profile-toggle');
  const profileOpts = profileToggle.querySelectorAll('.toggle-opt');
  const stopFrom = document.getElementById('stop-from');
  const stopTo = document.getElementById('stop-to');
  const routeSub = document.getElementById('route-sub');

  const START_POINTS = {
    io: { label: 'Monterotondo, Stazione FS', title: 'MONTEROTONDO', sub: 'Stazione FS' },
    papa: { label: 'Flaminio, Roma', title: 'FLAMINIO (con papà)', sub: 'Flaminio' }
  };
  const ANDATA_DEST = 'Via Giuseppe Garibaldi, 5, Talamone, Fonteblanda GR';
  let direction = 'andata';
  let profile = 'io';

  const mapsLinkInput = document.getElementById('maps-link');
  const importLinkBtn = document.getElementById('import-link-btn');
  const apiKeyInput = document.getElementById('api-key');
  const originInput = document.getElementById('origin-input');
  const destinationInput = document.getElementById('destination-input');
  const liveUpdateBtn = document.getElementById('live-update-btn');
  const liveStatus = document.getElementById('live-status');

  const sheet = document.getElementById('flap-editor');
  const sheetTitle = document.getElementById('flap-editor-title');
  const sheetInput = document.getElementById('flap-editor-input');
  const sheetCancel = document.getElementById('flap-editor-cancel');
  const sheetSave = document.getElementById('flap-editor-save');

  const gmaps = (from, to) =>
    `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=transit`;

  let currentLegs = [];
  let liveActive = false;

  // ================= Import dal link Google Maps =================
  function parseMapsLink(raw) {
    const url = raw.trim();
    if (!url) return { error: 'Incolla prima un link.' };
    if (/maps\.app\.goo\.gl/i.test(url)) {
      return { error: 'Questo è uno short link: aprilo nel browser, poi copia l\'URL completo dalla barra degli indirizzi e incollalo qui.' };
    }

    const dirMatch = url.match(/\/dir\/([^/]+)\/([^/]+)/);
    let origin = null, destination = null;
    if (dirMatch) {
      origin = cleanPlaceText(dirMatch[1]);
      destination = cleanPlaceText(dirMatch[2]);
    }

    let departure = null;
    const timeMatch = url.match(/!8j(\d{9,11})/);
    if (timeMatch) {
      departure = new Date(parseInt(timeMatch[1], 10) * 1000);
    }

    if (!origin && !destination && !departure) {
      return { error: 'Non riesco a leggere partenza/arrivo/orario da questo link. Puoi comunque compilare i campi a mano qui sotto.' };
    }
    return { origin, destination, departure };
  }

  function cleanPlaceText(segment) {
    try {
      let text = decodeURIComponent(segment.replace(/\+/g, ' '));
      text = text.replace(/\s*#\s*[0-9a-f]{4,}\s*$/i, ''); // rimuove eventuali id interni tipo "# f13938"
      return text.trim();
    } catch {
      return segment;
    }
  }

  importLinkBtn.addEventListener('click', () => {
    const result = parseMapsLink(mapsLinkInput.value);
    if (result.error) {
      setLiveStatus(result.error, 'error');
      return;
    }
    if (result.origin) originInput.value = result.origin;
    if (result.destination) destinationInput.value = result.destination;
    if (result.departure) {
      dateInput.value = result.departure.toISOString().slice(0, 10);
      timeInput.value = result.departure.toTimeString().slice(0, 5);
    }
    setLiveStatus('Importato dal link. Ora premi "Calcola tragitto e orari live" per gli orari reali.', 'ok');
  });

  // ================= Direzione (andata/ritorno) e profilo (io / con papà) =================
  function updateHeaderForDirection() {
    const sp = START_POINTS[profile];
    if (direction === 'andata') {
      stopFrom.textContent = sp.title;
      stopTo.textContent = 'TALAMONE';
      routeSub.textContent = `${sp.sub} → via Giuseppe Garibaldi, 5 · Fonteblanda, Orbetello (GR)`;
    } else {
      stopFrom.textContent = 'TALAMONE';
      stopTo.textContent = sp.title;
      routeSub.textContent = `Via Giuseppe Garibaldi, 5 → ${sp.sub} (RM)`;
    }
  }

  function setStartPointField(value) {
    if (direction === 'andata') originInput.value = value;
    else destinationInput.value = value;
  }

  profileOpts.forEach(opt => {
    opt.addEventListener('click', () => {
      if (opt.dataset.val === profile) return;
      profileOpts.forEach(o => { o.classList.remove('is-active'); o.setAttribute('aria-checked', 'false'); });
      opt.classList.add('is-active');
      opt.setAttribute('aria-checked', 'true');
      profile = opt.dataset.val;

      setStartPointField(START_POINTS[profile].label);
      updateHeaderForDirection();
      liveActive = false;
      setLiveStatus('', null);
      render();
    });
  });

  directionOpts.forEach(opt => {
    opt.addEventListener('click', () => {
      if (opt.dataset.val === direction) return;
      directionOpts.forEach(o => { o.classList.remove('is-active'); o.setAttribute('aria-checked', 'false'); });
      opt.classList.add('is-active');
      opt.setAttribute('aria-checked', 'true');
      direction = opt.dataset.val;

      // scambia partenza/destinazione se sono ancora quelle di default o quelle appena scambiate
      const o = originInput.value;
      originInput.value = destinationInput.value;
      destinationInput.value = o;

      updateHeaderForDirection();
      liveActive = false;
      setLiveStatus('', null);
      render();
    });
  });

  // ================= Chiave API salvata =================
  apiKeyInput.value = localStorage.getItem(API_KEY_STORAGE) || '';
  apiKeyInput.addEventListener('change', () => {
    localStorage.setItem(API_KEY_STORAGE, apiKeyInput.value.trim());
  });

  // ================= Google Maps Directions live =================
  function loadMapsScript(key) {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.maps && window.google.maps.DirectionsService) {
        resolve();
        return;
      }
      const existing = document.getElementById('gmaps-script');
      if (existing) existing.remove();
      const script = document.createElement('script');
      script.id = 'gmaps-script';
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Impossibile caricare Google Maps: controlla la chiave API e la connessione.'));
      document.head.appendChild(script);
    });
  }

  function fetchLiveRoute({ origin, destination, departureTime, apiKey }) {
    return loadMapsScript(apiKey).then(() => new Promise((resolve, reject) => {
      const service = new google.maps.DirectionsService();
      service.route({
        origin,
        destination,
        travelMode: google.maps.TravelMode.TRANSIT,
        transitOptions: { departureTime }
      }, (result, status) => {
        if (status === 'OK' && result.routes && result.routes[0]) {
          resolve(result.routes[0]);
        } else {
          reject(new Error('Google Maps non ha trovato un percorso in transito (' + status + ').'));
        }
      });
    }));
  }

  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    return div.textContent.trim();
  }

  function stepsToLegs(steps) {
    return steps.map((step, i) => {
      if (step.travel_mode === 'WALKING') {
        return {
          id: 'live-' + i,
          mode: 'piedi',
          line: 'A piedi',
          from: stripHtml(step.instructions) || 'Tratto a piedi',
          to: '',
          note: step.distance ? step.distance.text + (step.duration ? ' · ' + step.duration.text : '') : '',
          depTime: '', arrTime: '',
          noPlatform: true, live: null
        };
      }
      const td = step.transit;
      if (!td) {
        return {
          id: 'live-' + i, mode: 'piedi', line: 'Spostamento', from: stripHtml(step.instructions) || '', to: '',
          note: '', depTime: '', arrTime: '', noPlatform: true, live: null
        };
      }
      const vehicleType = (td.line.vehicle && td.line.vehicle.type) || '';
      const isTrain = /RAIL|TRAIN/i.test(vehicleType);
      const isMetro = /SUBWAY|METRO/i.test(vehicleType);
      return {
        id: 'live-' + i,
        mode: isTrain ? 'treno' : (isMetro ? 'metro' : 'bus'),
        line: (td.line.short_name || td.line.name || (isTrain ? 'Treno' : (isMetro ? 'Metro' : 'Autobus'))),
        from: td.departure_stop.name,
        to: td.arrival_stop.name,
        note: td.headsign ? ('Direzione ' + td.headsign) : '',
        depTime: td.departure_time ? td.departure_time.text : '',
        arrTime: td.arrival_time ? td.arrival_time.text : '',
        live: gmaps(td.departure_stop.name, td.arrival_stop.name)
      };
    });
  }

  function setLiveStatus(msg, kind) {
    liveStatus.textContent = msg;
    liveStatus.className = 'live-status' + (kind ? ' is-' + kind : '');
  }

  liveUpdateBtn.addEventListener('click', () => {
    const apiKey = apiKeyInput.value.trim();
    const origin = originInput.value.trim();
    const destination = destinationInput.value.trim();
    const date = dateInput.value;
    const time = timeInput.value || '08:00';

    if (!apiKey) {
      setLiveStatus('Senza chiave API mostro solo il tragitto generico (modalità manuale qui sotto). Inserisci una chiave per orari e linee reali.', 'error');
      liveActive = false;
      render();
      return;
    }
    if (!origin || !destination) {
      setLiveStatus('Servono partenza e destinazione.', 'error');
      return;
    }

    localStorage.setItem(API_KEY_STORAGE, apiKey);
    setLiveStatus('Sto calcolando il tragitto…', 'loading');
    liveUpdateBtn.disabled = true;

    const departureTime = date ? new Date(`${date}T${time}:00`) : new Date();

    fetchLiveRoute({ origin, destination, departureTime, apiKey })
      .then((route) => {
        const leg = route.legs && route.legs[0];
        if (!leg) throw new Error('Risposta senza tratte.');
        currentLegs = stepsToLegs(leg.steps);
        liveActive = true;
        setLiveStatus('Tragitto aggiornato: ' + currentLegs.length + ' tappe trovate.', 'ok');
        renderBoard(currentLegs);
      })
      .catch((err) => {
        setLiveStatus(err.message || 'Errore nel calcolo del tragitto.', 'error');
        liveActive = false;
        render();
      })
      .finally(() => {
        liveUpdateBtn.disabled = false;
      });
  });

  // ================= Itinerario manuale (fallback senza API) =================
  function buildLegsAndata(mode, profile) {
    const legs = profile === 'papa' ? [
      {
        id: 'l1p', mode: 'metro', line: 'Metro A · direzione Anagnina',
        from: 'Flaminio', to: 'Roma Termini',
        note: 'Collegamento diretto, circa 10 min.',
        depTime: '', arrTime: '',
        live: gmaps('Flaminio', 'Roma Termini')
      }
    ] : [
      {
        id: 'l1', mode: 'treno', line: 'FL1',
        from: 'Monterotondo-Mentana', to: 'Roma Tiburtina',
        note: 'Diverse corse ogni ora, circa 30-35 min di viaggio.',
        depTime: '', arrTime: '',
        live: gmaps('Stazione Monterotondo-Mentana', 'Roma Tiburtina')
      },
      {
        id: 'l1b', mode: 'metro', line: 'Metro B · direzione Laurentina',
        from: 'Roma Tiburtina', to: 'Roma Termini',
        note: 'Collegamento interno a Roma, circa 10 min (o 15-20 min a piedi se preferisci).',
        depTime: '', arrTime: '',
        live: gmaps('Roma Tiburtina', 'Roma Termini')
      }
    ];

    if (mode === 'diretto') {
      legs.push({
        id: 'l2', mode: 'treno', line: 'Regionale / IC · linea Tirrenica',
        from: 'Roma Termini', to: 'Talamone',
        note: 'Verifica che il treno scelto fermi davvero a Talamone: è una fermata solo per alcuni regionali. Alcuni regionali partono da Tiburtina invece che da Termini: controlla il binario di partenza sul biglietto.',
        depTime: '', arrTime: '',
        live: gmaps('Roma Termini', 'Stazione di Talamone')
      });
      legs.push({
        id: 'l3', mode: 'bus', line: 'Autolinee Toscane',
        from: 'Stazione di Talamone', to: 'Talamone Porto',
        note: 'La stazione è a circa 4 km dal paese: bus di collegamento, in alternativa taxi.',
        depTime: '', arrTime: '',
        live: gmaps('Stazione di Talamone', 'Talamone Porto')
      });
    } else {
      legs.push({
        id: 'l2', mode: 'treno', line: 'Regionale / IC · linea Tirrenica',
        from: 'Roma Termini', to: 'Grosseto (o Orbetello)',
        note: 'Scegli Grosseto o Orbetello in base alla coincidenza bus migliore. Alcuni regionali partono da Tiburtina invece che da Termini: controlla il binario di partenza sul biglietto.',
        depTime: '', arrTime: '',
        live: gmaps('Roma Termini', 'Stazione di Grosseto')
      });
      legs.push({
        id: 'l3', mode: 'bus', line: 'Autolinee Toscane',
        from: 'Stazione di Grosseto / Orbetello', to: 'Talamone Porto',
        note: 'Corse meno frequenti dei treni: controlla l’orario prima di scegliere questa opzione.',
        depTime: '', arrTime: '',
        live: gmaps('Stazione di Grosseto', 'Talamone Porto')
      });
    }

    legs.push({
      id: 'l4', mode: 'piedi', line: 'A piedi',
      from: 'Talamone Porto', to: 'Via Giuseppe Garibaldi, 5',
      note: 'Pochi minuti nel centro storico, nessun binario.',
      depTime: '', arrTime: '',
      live: null, noPlatform: true
    });

    return legs;
  }

  function buildLegsRitorno(mode, profile) {
    const legs = [
      {
        id: 'r1', mode: 'piedi', line: 'A piedi',
        from: 'Via Giuseppe Garibaldi, 5', to: 'Talamone Porto',
        note: 'Pochi minuti nel centro storico, nessun binario.',
        depTime: '', arrTime: '',
        live: null, noPlatform: true
      }
    ];

    if (mode === 'diretto') {
      legs.push({
        id: 'r2', mode: 'bus', line: 'Autolinee Toscane',
        from: 'Talamone Porto', to: 'Stazione di Talamone',
        note: 'La stazione è a circa 4 km dal paese: bus di collegamento, in alternativa taxi.',
        depTime: '', arrTime: '',
        live: gmaps('Talamone Porto', 'Stazione di Talamone')
      });
      legs.push({
        id: 'r3', mode: 'treno', line: 'Regionale / IC · linea Tirrenica',
        from: 'Talamone', to: 'Roma Termini',
        note: 'Verifica che il treno scelto fermi davvero a Talamone: è una fermata solo per alcuni regionali. Alcuni regionali arrivano a Tiburtina invece che a Termini: controlla la stazione di arrivo sul biglietto.',
        depTime: '', arrTime: '',
        live: gmaps('Stazione di Talamone', 'Roma Termini')
      });
    } else {
      legs.push({
        id: 'r2', mode: 'bus', line: 'Autolinee Toscane',
        from: 'Talamone Porto', to: 'Stazione di Grosseto / Orbetello',
        note: 'Corse meno frequenti dei treni: controlla l’orario prima di scegliere questa opzione.',
        depTime: '', arrTime: '',
        live: gmaps('Talamone Porto', 'Stazione di Grosseto')
      });
      legs.push({
        id: 'r3', mode: 'treno', line: 'Regionale / IC · linea Tirrenica',
        from: 'Grosseto (o Orbetello)', to: 'Roma Termini',
        note: 'Scegli Grosseto o Orbetello in base alla coincidenza bus migliore. Alcuni regionali arrivano a Tiburtina invece che a Termini: controlla la stazione di arrivo sul biglietto.',
        depTime: '', arrTime: '',
        live: gmaps('Stazione di Grosseto', 'Roma Termini')
      });
    }

    if (profile === 'papa') {
      legs.push({
        id: 'r4p', mode: 'metro', line: 'Metro A · direzione Battistini',
        from: 'Roma Termini', to: 'Flaminio',
        note: 'Collegamento diretto, circa 10 min.',
        depTime: '', arrTime: '',
        live: gmaps('Roma Termini', 'Flaminio')
      });
    } else {
      legs.push({
        id: 'r3b', mode: 'metro', line: 'Metro B · direzione Rebibbia',
        from: 'Roma Termini', to: 'Roma Tiburtina',
        note: 'Collegamento interno a Roma, circa 10 min (o 15-20 min a piedi se preferisci).',
        depTime: '', arrTime: '',
        live: gmaps('Roma Termini', 'Roma Tiburtina')
      });

      legs.push({
        id: 'r4', mode: 'treno', line: 'FL1',
        from: 'Roma Tiburtina', to: 'Monterotondo-Mentana',
        note: 'Diverse corse ogni ora, circa 30-35 min di viaggio.',
        depTime: '', arrTime: '',
        live: gmaps('Roma Tiburtina', 'Stazione Monterotondo-Mentana')
      });
    }

    return legs;
  }

  function buildLegsManual(mode) {
    return direction === 'ritorno' ? buildLegsRitorno(mode, profile) : buildLegsAndata(mode, profile);
  }

  const modeLabel = { treno: 'Treno', bus: 'Autobus', metro: 'Metro', piedi: 'A piedi' };
  const modeDot = { treno: 'dot-treno', bus: 'dot-bus', metro: 'dot-metro', piedi: 'dot-piedi' };

  // ================= Persistenza binari =================
  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch { return {}; }
  }
  function saveStore(store) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }
  function tripKey() {
    if (liveActive) {
      return `live__${direction}__${profile}__${dateInput.value}__${timeInput.value}__${originInput.value}__${destinationInput.value}`;
    }
    const date = dateInput.value || 'senza-data';
    const mode = toggle.querySelector('.is-active').dataset.val;
    return `manual__${direction}__${profile}__${date}__${mode}`;
  }
  function getPlatform(legId, which) {
    const store = loadStore();
    const trip = store[tripKey()] || {};
    return trip[`${legId}_${which}`] || '';
  }
  function setPlatform(legId, which, value) {
    const store = loadStore();
    const key = tripKey();
    store[key] = store[key] || {};
    store[key][`${legId}_${which}`] = value;
    saveStore(store);
  }

  // ================= Render =================
  function render() {
    if (liveActive) return;
    const mode = toggle.querySelector('.is-active').dataset.val;
    currentLegs = buildLegsManual(mode);
    renderBoard(currentLegs);
  }

  function renderBoard(legs) {
    boardBody.innerHTML = '';

    legs.forEach(leg => {
      const row = document.createElement('div');
      row.className = 'leg-row' + (leg.mode === 'piedi' ? ' is-walk' : '');
      row.setAttribute('role', 'row');

      const modeCell = document.createElement('div');
      modeCell.className = 'leg-mode';
      modeCell.innerHTML = `<span class="dot ${modeDot[leg.mode]}"></span>${modeLabel[leg.mode]}`;
      row.appendChild(modeCell);

      const routeCell = document.createElement('div');
      routeCell.className = 'leg-route';
      routeCell.innerHTML = `
        <span class="leg-line">${leg.line}</span>
        <span class="leg-from-to">${leg.from}${leg.to ? ' → ' + leg.to : ''}</span>
        ${leg.note ? `<span class="leg-note">${leg.note}</span>` : ''}
        ${leg.live ? `<a class="leg-live" href="${leg.live}" target="_blank" rel="noopener">Apri su Google Maps ↗</a>` : ''}
      `;
      row.appendChild(routeCell);

      row.appendChild(buildCellGroup(leg));

      boardBody.appendChild(row);
    });

    updateInstallHint();
  }

  function buildCellGroup(leg) {
    const group = document.createElement('div');
    group.className = 'leg-cell-group';

    group.appendChild(buildTimeCell('Partenza', leg.depTime || 'consulta live'));
    group.appendChild(buildFlapCell(leg, 'dep', 'Bin. partenza'));
    group.appendChild(buildTimeCell('Arrivo', leg.arrTime || 'consulta live'));
    group.appendChild(buildFlapCell(leg, 'arr', 'Bin. arrivo'));

    return group;
  }

  function buildTimeCell(label, value) {
    const cell = document.createElement('div');
    cell.className = 'time-cell';
    cell.innerHTML = `<span class="cell-label">${label}</span><span class="time-value">${value}</span>`;
    return cell;
  }

  function buildFlapCell(leg, which, label) {
    const cell = document.createElement('div');
    cell.className = 'time-cell';

    const cellLabel = document.createElement('span');
    cellLabel.className = 'cell-label';
    cellLabel.textContent = label;
    cell.appendChild(cellLabel);

    if (leg.noPlatform) {
      const span = document.createElement('span');
      span.className = 'flap is-empty';
      span.textContent = '—';
      cell.appendChild(span);
      return cell;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    const value = getPlatform(leg.id, which);
    btn.className = 'flap ' + (value ? 'is-set' : 'is-empty');
    btn.textContent = value || '?';
    btn.setAttribute('aria-label', `${label} per ${leg.from}${leg.to ? ' → ' + leg.to : ''}. ${value ? 'Valore attuale ' + value : 'Non ancora inserito'}`);
    btn.addEventListener('click', () => openEditor(leg, which, label, btn));
    cell.appendChild(btn);
    return cell;
  }

  // ================= Editor a foglio =================
  let editingCtx = null;

  function openEditor(leg, which, label, btn) {
    editingCtx = { leg, which, btn };
    sheetTitle.textContent = label;
    sheetInput.value = getPlatform(leg.id, which);
    sheet.hidden = false;
    setTimeout(() => sheetInput.focus(), 50);
  }

  function closeEditor() {
    sheet.hidden = true;
    editingCtx = null;
  }

  sheetCancel.addEventListener('click', closeEditor);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeEditor(); });

  sheetSave.addEventListener('click', () => {
    if (!editingCtx) return;
    const value = sheetInput.value.trim();
    setPlatform(editingCtx.leg.id, editingCtx.which, value);
    editingCtx.btn.textContent = value || '?';
    editingCtx.btn.className = 'flap flap-flip ' + (value ? 'is-set' : 'is-empty');
    closeEditor();
  });

  sheetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sheetSave.click();
    if (e.key === 'Escape') closeEditor();
  });

  // ================= Controlli manuali =================
  toggleOpts.forEach(opt => {
    opt.addEventListener('click', () => {
      toggleOpts.forEach(o => { o.classList.remove('is-active'); o.setAttribute('aria-checked', 'false'); });
      opt.classList.add('is-active');
      opt.setAttribute('aria-checked', 'true');
      liveActive = false;
      render();
    });
  });

  dateInput.addEventListener('change', () => { if (!liveActive) render(); });

  resetBtn.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    if (liveActive) renderBoard(currentLegs);
    else render();
  });

  function updateInstallHint() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    document.getElementById('install-hint').hidden = !!isStandalone;
  }

  // Data/ora di default: adesso
  (function initDate() {
    const now = new Date();
    dateInput.value = now.toISOString().slice(0, 10);
    dateInput.min = now.toISOString().slice(0, 10);
    timeInput.value = now.toTimeString().slice(0, 5);
  })();

  updateHeaderForDirection();
  render();

  // ================= Service worker =================
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
