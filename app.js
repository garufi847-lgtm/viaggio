(() => {
  'use strict';

  const STORAGE_KEY = 'talamone-trip-v1';
  const VT_CACHE_KEY = 'talamone-vt-station-cache';
  const VT_BASE = 'https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/';

  const boardBody = document.getElementById('board-body');
  const dateInput = document.getElementById('trip-date');
  const timeInput = document.getElementById('trip-time');
  const resetBtn = document.getElementById('reset-btn');
  const directionToggle = document.getElementById('direction-toggle');
  const directionOpts = directionToggle.querySelectorAll('.toggle-opt');
  const profileToggle = document.getElementById('profile-toggle');
  const profileOpts = profileToggle.querySelectorAll('.toggle-opt');
  const stopFrom = document.getElementById('stop-from');
  const stopTo = document.getElementById('stop-to');
  const routeSub = document.getElementById('route-sub');

  const sheet = document.getElementById('flap-editor');
  const sheetTitle = document.getElementById('flap-editor-title');
  const sheetInput = document.getElementById('flap-editor-input');
  const sheetCancel = document.getElementById('flap-editor-cancel');
  const sheetSave = document.getElementById('flap-editor-save');

  const START_POINTS = {
    io: { label: 'Monterotondo, Stazione FS', title: 'MONTEROTONDO', sub: 'Stazione FS' },
    papa: { label: 'Flaminio, Roma', title: 'FLAMINIO (con papà)', sub: 'Flaminio' }
  };
  let direction = 'andata';
  let profile = 'io';
  let currentLegs = [];

  const gmaps = (from, to) =>
    `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=transit`;

  // ================= ViaggiaTreno (gratis, senza chiave, solo treni) =================
  // ViaggiaTreno non manda header CORS: passiamo da un proxy pubblico gratuito.
  // Proviamo più proxy in sequenza in caso uno sia giù o troppo lento.
  const CORS_PROXIES = [
    (url) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
    (url) => 'https://corsproxy.io/?url=' + encodeURIComponent(url)
  ];

  async function vtFetchRaw(path) {
    const targetUrl = VT_BASE + path;
    let lastErr = null;
    for (const proxy of CORS_PROXIES) {
      try {
        const res = await fetch(proxy(targetUrl));
        if (!res.ok) { lastErr = new Error('ViaggiaTreno ha risposto con errore (' + res.status + ').'); continue; }
        return res;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Nessun proxy disponibile al momento.');
  }

  function vtLoadCache() {
    try { return JSON.parse(localStorage.getItem(VT_CACHE_KEY)) || {}; }
    catch { return {}; }
  }
  function vtSaveCache(cache) {
    localStorage.setItem(VT_CACHE_KEY, JSON.stringify(cache));
  }

  async function vtResolveStationId(name) {
    const cache = vtLoadCache();
    const key = name.trim().toUpperCase();
    if (cache[key]) return cache[key];

    const query = name.split(',')[0].split('(')[0].trim(); // "Roma Termini" da "Roma Termini, ..."
    const res = await vtFetchRaw('autocompletaStazione/' + encodeURIComponent(query));
    const text = await res.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Nessuna stazione trovata per "' + query + '".');

    // preferisci la corrispondenza più vicina al nome cercato
    const upperQuery = query.toUpperCase();
    let best = lines[0];
    let bestScore = -1;
    lines.forEach(line => {
      const [stationName] = line.split('|');
      let score = 0;
      if (stationName === upperQuery) score = 100;
      else if (stationName.startsWith(upperQuery)) score = 50;
      else if (stationName.includes(upperQuery)) score = 10;
      if (score > bestScore) { bestScore = score; best = line; }
    });

    const id = best.split('|')[1];
    if (!id) throw new Error('Formato di risposta inatteso per "' + query + '".');
    cache[key] = id.trim();
    vtSaveCache(cache);
    return cache[key];
  }

  async function vtFetchJSON(path) {
    const res = await vtFetchRaw(path);
    return res.json();
  }

  function vtDestinationKeywords(toText) {
    // estrae parole chiave "forti" dal nome destinazione per il match sui treni
    return toText
      .replace(/\(.*?\)/g, '')
      .split(/[\s,/]+/)
      .map(w => w.trim().toUpperCase())
      .filter(w => w.length > 3 && !['STAZIONE', 'ROMA', 'PORTO'].includes(w));
  }

  async function vtRefreshTrainLeg(leg) {
    const originId = await vtResolveStationId(leg.from);
    const date = dateInput.value;
    const time = timeInput.value || '08:00';
    const when = date ? new Date(`${date}T${time}:00`) : new Date();

    const departures = await vtFetchJSON('partenze/' + originId + '/' + encodeURIComponent(when.toString()));
    if (!Array.isArray(departures) || !departures.length) {
      throw new Error('Nessun treno in partenza trovato da questa stazione in quella fascia oraria.');
    }

    const keywords = vtDestinationKeywords(leg.to);
    const scored = departures.map(t => {
      const dest = (t.destinazione || '').toUpperCase();
      const matches = keywords.filter(k => dest.includes(k)).length;
      return { t, matches };
    }).sort((a, b) => b.matches - a.matches);

    const chosen = (scored[0] && scored[0].matches > 0) ? scored[0].t : departures[0];
    const approx = !(scored[0] && scored[0].matches > 0);

    const ritardo = typeof chosen.ritardo === 'number' ? chosen.ritardo : 0;
    const depTimeBase = chosen.compOrarioPartenza || '';
    leg.depTime = depTimeBase + (ritardo > 0 ? ` (+${ritardo}′)` : ritardo < 0 ? ` (${ritardo}′)` : '');
    const binarioPart = chosen.binarioEffettivoPartenzaDescrizione || chosen.binarioProgrammatoPartenzaDescrizione;
    if (binarioPart) setPlatform(leg.id, 'dep', String(binarioPart));

    leg.trainLabel = (chosen.compNumeroTreno || '').trim();
    leg.approxMatch = approx;

    // prova a recuperare orario/binario di arrivo dalla stazione di destinazione
    try {
      const destId = await vtResolveStationId(leg.to);
      const arrivals = await vtFetchJSON('arrivi/' + destId + '/' + encodeURIComponent(when.toString()));
      const match = Array.isArray(arrivals)
        ? arrivals.find(a => a.numeroTreno === chosen.numeroTreno)
        : null;
      if (match) {
        leg.arrTime = match.compOrarioArrivo || '';
        const binarioArr = match.binarioEffettivoArrivoDescrizione || match.binarioProgrammatoArrivoDescrizione;
        if (binarioArr) setPlatform(leg.id, 'arr', String(binarioArr));
      }
    } catch {
      // arrivo non recuperabile: lasciamo solo la partenza, nessun errore bloccante
    }

    return { approx };
  }

  // ================= Navigazione tra pagine =================
  document.querySelectorAll('.page-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.page-nav-btn').forEach(b => {
        b.classList.remove('is-active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('is-active');
      btn.setAttribute('aria-selected', 'true');

      const target = btn.dataset.page;
      document.querySelectorAll('.page').forEach(p => {
        p.classList.toggle('is-hidden', p.id !== `page-${target}`);
      });
    });
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

  profileOpts.forEach(opt => {
    opt.addEventListener('click', () => {
      if (opt.dataset.val === profile) return;
      profileOpts.forEach(o => { o.classList.remove('is-active'); o.setAttribute('aria-checked', 'false'); });
      opt.classList.add('is-active');
      opt.setAttribute('aria-checked', 'true');
      profile = opt.dataset.val;
      updateHeaderForDirection();
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
      updateHeaderForDirection();
      render();
    });
  });

  // ================= Itinerario =================
  function buildLegsAndata(profile) {
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

    legs.push({
      id: 'l2', mode: 'treno', line: 'Treno 4130 · direzione Pisa Centrale',
      from: 'Roma Termini', to: 'Orbetello-Monte Argentario',
      note: 'Parte da Roma Termini alle 10:12, arriva a Orbetello-Monte Argentario alle 12:25.',
      depTime: '10:12', arrTime: '12:25',
      live: gmaps('Roma Termini', 'Stazione di Orbetello-Monte Argentario')
    });
    legs.push({
      id: 'l3', mode: 'bus', line: 'Autobus 390',
      from: 'Orbetello', to: 'Talamone Porto',
      note: '18 fermate da Orbetello a Talamone Porto.',
      depTime: '13:30', arrTime: '13:55',
      live: gmaps('Stazione di Orbetello-Monte Argentario', 'Talamone Porto'),
      photo: (window.APP_PHOTOS && window.APP_PHOTOS.fermataOrbetello) || 'assets/fermata-orbetello.jpg',
      photoCaption: 'Fermata Marebus di partenza a Orbetello'
    });

    legs.push({
      id: 'l4', mode: 'piedi', line: 'A piedi',
      from: 'Talamone Porto', to: 'Via Giuseppe Garibaldi, 5',
      note: 'Pochi minuti nel centro storico, nessun binario.',
      depTime: '', arrTime: '',
      live: null, noPlatform: true
    });

    return legs;
  }

  function buildLegsRitorno(profile) {
    const legs = [
      {
        id: 'r1', mode: 'piedi', line: 'A piedi',
        from: 'Via Giuseppe Garibaldi, 5', to: 'Talamone Porto',
        note: 'Pochi minuti nel centro storico, nessun binario.',
        depTime: '', arrTime: '',
        live: null, noPlatform: true
      }
    ];

    legs.push({
      id: 'r2', mode: 'bus', line: 'Autobus 390',
      from: 'Talamone Porto', to: 'Orbetello',
      note: '18 fermate da Talamone Porto a Orbetello.',
      depTime: '', arrTime: '',
      live: gmaps('Talamone Porto', 'Stazione di Orbetello-Monte Argentario')
    });
    legs.push({
      id: 'r3', mode: 'treno', line: 'Treno · linea Tirrenica',
      from: 'Orbetello-Monte Argentario', to: 'Roma Termini',
      note: 'Controlla l’orario di ritorno da Orbetello: verifica se il treno arriva a Termini o a Tiburtina.',
      depTime: '', arrTime: '',
      live: gmaps('Stazione di Orbetello-Monte Argentario', 'Roma Termini')
    });

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

  function buildLegs() {
    return direction === 'ritorno' ? buildLegsRitorno(profile) : buildLegsAndata(profile);
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
    const date = dateInput.value || 'senza-data';
    return `${direction}__${profile}__${date}`;
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
    currentLegs = buildLegs();
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
        ${leg.photo ? `
          <figure class="leg-photo">
            <img src="${leg.photo}" alt="${leg.photoCaption || 'Foto della fermata'}" loading="lazy" onerror="this.closest('.leg-photo').classList.add('is-broken')">
            <figcaption>${leg.photoCaption || ''}</figcaption>
          </figure>` : ''}
        ${leg.live ? `<a class="leg-gmaps" href="${leg.live}" target="_blank" rel="noopener">Apri su Google Maps ↗</a>` : ''}
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

    group.appendChild(buildTimeCell('Partenza', leg.depTime || '—', `time-${leg.id}-dep`));
    group.appendChild(buildFlapCell(leg, 'dep', 'Bin. partenza'));
    group.appendChild(buildTimeCell('Arrivo', leg.arrTime || '—', `time-${leg.id}-arr`));
    group.appendChild(buildFlapCell(leg, 'arr', 'Bin. arrivo'));

    return group;
  }

  function buildTimeCell(label, value, id) {
    const cell = document.createElement('div');
    cell.className = 'time-cell';
    cell.innerHTML = `<span class="cell-label">${label}</span><span class="time-value" id="${id || ''}">${value}</span>`;
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
    btn.dataset.flap = `${leg.id}-${which}`;
    const value = getPlatform(leg.id, which);
    btn.className = 'flap ' + (value ? 'is-set' : 'is-empty');
    btn.textContent = value || '+';
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
    editingCtx.btn.textContent = value || '+';
    editingCtx.btn.className = 'flap flap-flip ' + (value ? 'is-set' : 'is-empty');
    closeEditor();
  });

  sheetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sheetSave.click();
    if (e.key === 'Escape') closeEditor();
  });

  // ================= Controlli =================
  dateInput.addEventListener('change', () => { render(); loadWeather(); });

  resetBtn.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    render();
  });

  function updateInstallHint() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    document.getElementById('install-hint').hidden = !!isStandalone;
  }

  // ================= Meteo (Open-Meteo, gratis, senza chiave) =================
  const WEATHER_CODES = {
    0: ['☀️', 'Sereno'], 1: ['🌤️', 'Poco nuvoloso'], 2: ['⛅', 'Parz. nuvoloso'], 3: ['☁️', 'Coperto'],
    45: ['🌫️', 'Nebbia'], 48: ['🌫️', 'Nebbia'],
    51: ['🌦️', 'Pioviggine'], 53: ['🌦️', 'Pioviggine'], 55: ['🌦️', 'Pioviggine'],
    61: ['🌧️', 'Pioggia debole'], 63: ['🌧️', 'Pioggia'], 65: ['🌧️', 'Pioggia forte'],
    71: ['🌨️', 'Neve'], 73: ['🌨️', 'Neve'], 75: ['🌨️', 'Neve forte'],
    80: ['🌦️', 'Rovesci'], 81: ['🌦️', 'Rovesci'], 82: ['⛈️', 'Rovesci forti'],
    95: ['⛈️', 'Temporale'], 96: ['⛈️', 'Temporale con grandine'], 99: ['⛈️', 'Temporale con grandine']
  };

  async function loadWeather() {
    const card = document.getElementById('weather-card');
    try {
      const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=42.5536&longitude=11.1345&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=Europe%2FRome&forecast_days=14');
      if (!res.ok) return;
      const data = await res.json();
      const targetDate = dateInput.value;
      let idx = data.daily.time.indexOf(targetDate);
      if (idx === -1) idx = 0; // fuori dai 14 giorni disponibili: mostra oggi come riferimento

      const code = data.daily.weathercode[idx];
      const [icon, desc] = WEATHER_CODES[code] || ['🌡️', 'N/D'];
      const max = Math.round(data.daily.temperature_2m_max[idx]);
      const min = Math.round(data.daily.temperature_2m_min[idx]);

      document.getElementById('weather-icon').textContent = icon;
      document.getElementById('weather-temp').textContent = `${min}° / ${max}°`;
      document.getElementById('weather-desc').textContent = desc + (idx === 0 && targetDate !== data.daily.time[0] ? ' (oggi, data fuori previsione)' : '');
      card.hidden = false;
    } catch {
      card.hidden = true;
    }
  }

  // ================= Banner offline =================
  function updateOfflineBanner() {
    document.getElementById('offline-banner').hidden = navigator.onLine;
  }
  window.addEventListener('online', updateOfflineBanner);
  window.addEventListener('offline', updateOfflineBanner);

  // ================= Aggiungi al calendario (.ics) =================
  function pad(n) { return String(n).padStart(2, '0'); }

  function icsDate(dateStr, timeStr) {
    const clean = (timeStr.match(/^\d{2}:\d{2}/) || [])[0];
    if (!clean) return null;
    return dateStr.replace(/-/g, '') + 'T' + clean.replace(':', '') + '00';
  }

  function buildIcs(legs, dateStr) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Talamone Trip//IT'];
    let count = 0;
    legs.forEach(leg => {
      const dtStart = icsDate(dateStr, leg.depTime || '');
      if (!dtStart) return;
      const dtEnd = icsDate(dateStr, leg.arrTime || '') || dtStart;
      count++;
      lines.push(
        'BEGIN:VEVENT',
        'UID:' + leg.id + '-' + dateStr + '@talamone-trip',
        'DTSTART:' + dtStart,
        'DTEND:' + dtEnd,
        'SUMMARY:' + (leg.line || modeLabel[leg.mode]) + ' — ' + leg.from + (leg.to ? ' → ' + leg.to : ''),
        'DESCRIPTION:' + (leg.note || '').replace(/\n/g, ' '),
        'END:VEVENT'
      );
    });
    lines.push('END:VCALENDAR');
    return { ics: lines.join('\r\n'), count };
  }

  document.getElementById('calendar-btn').addEventListener('click', () => {
    const { ics, count } = buildIcs(currentLegs, dateInput.value || new Date().toISOString().slice(0, 10));
    if (!count) {
      alert('Nessun orario preciso disponibile per questa direzione: aggiungi almeno un orario prima di esportare.');
      return;
    }
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'talamone-' + direction + '.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // ================= Condividi tragitto =================
  function buildShareText(legs) {
    const sp = START_POINTS[profile];
    const header = direction === 'andata'
      ? `${sp.title} → TALAMONE`
      : `TALAMONE → ${sp.title}`;
    const lines = [header, dateInput.value || '', ''];
    legs.forEach(leg => {
      const time = leg.depTime ? `${leg.depTime}${leg.arrTime ? ' → ' + leg.arrTime : ''} · ` : '';
      lines.push(`${modeLabel[leg.mode]} ${time}${leg.line}`);
      lines.push(`  ${leg.from}${leg.to ? ' → ' + leg.to : ''}`);
    });
    return lines.join('\n');
  }

  document.getElementById('share-btn').addEventListener('click', async () => {
    const text = buildShareText(currentLegs);
    if (navigator.share) {
      try { await navigator.share({ title: 'Tragitto Talamone', text }); }
      catch { /* utente ha annullato, nessun errore da mostrare */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      alert('Tragitto copiato negli appunti — incollalo dove vuoi.');
    } catch {
      window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
    }
  });

  // Data/ora di default: adesso
  (function initDate() {
    const now = new Date();
    dateInput.value = now.toISOString().slice(0, 10);
    dateInput.min = now.toISOString().slice(0, 10);
    timeInput.value = now.toTimeString().slice(0, 5);
  })();

  updateHeaderForDirection();
  render();
  updateOfflineBanner();
  loadWeather();

  // ================= Service worker =================
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        // controlla subito e poi ogni minuto se c'è una versione più nuova sul server
        reg.update().catch(() => {});
        setInterval(() => reg.update().catch(() => {}), 60 * 1000);
      }).catch(() => {});

      // quando un nuovo service worker prende il controllo, ricarica la pagina da solo
      let alreadyRefreshed = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (alreadyRefreshed) return;
        alreadyRefreshed = true;
        window.location.reload();
      });
    });
  }
})();
