// Reine Zustandslogik für den go-e Auto-Import.
// Ziel: Energie bevorzugt aus dem geeichten Gesamtzähler (eto) ableiten,
// ohne den Peak-Tracker als dauerhaften Importzustand zu missbrauchen.

export function normalizeEto(raw) {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export function meterSessionKey(serial, totalWh) {
  if (!serial || !Number.isSafeInteger(totalWh) || totalWh <= 0) return null;
  return `goe:${serial}:${totalWh}`;
}

function freshState(serial, car, totalWh, observedAt) {
  return {
    version: 1,
    serial,
    lastCar: car,
    lastEto: totalWh,
    idleEto: car === 1 ? totalWh : null,
    sessionStartEto: null,
    sessionSeenCharging: car === 2,
    updatedAt: observedAt,
  };
}

// Liefert den neuen Zustand und – nur bei einem beobachteten Abschluss –
// ein belastbares eto-Delta. Wenn der Importzustand mitten in einer Ladung
// initialisiert wurde, bleibt completed=null und der Aufrufer darf auf wh
// zurückfallen.
export function advanceImportState(previous, observation) {
  const { serial, car, totalWh, observedAt = new Date().toISOString() } = observation;

  if (!serial || !Number.isInteger(car) || !Number.isSafeInteger(totalWh) || totalWh < 0) {
    return { state: previous || null, completed: null, reset: false };
  }

  const prev = previous && previous.serial === serial ? previous : null;
  if (!prev || !Number.isSafeInteger(prev.lastEto)) {
    return { state: freshState(serial, car, totalWh, observedAt), completed: null, reset: false };
  }

  // eto sollte monoton steigen. Bei Zählerwechsel/Reset lieber neu initialisieren
  // als ein riesiges oder negatives Delta zu erzeugen.
  if (totalWh < prev.lastEto) {
    return { state: freshState(serial, car, totalWh, observedAt), completed: null, reset: true };
  }

  let idleEto = Number.isSafeInteger(prev.idleEto) ? prev.idleEto : null;
  let sessionStartEto = Number.isSafeInteger(prev.sessionStartEto) ? prev.sessionStartEto : null;
  let sessionSeenCharging = Boolean(prev.sessionSeenCharging);
  let completed = null;

  if (car === 2) {
    // Neue beobachtete Ladephase: nur ein zuvor im Idle gemessener Zählerstand
    // ist eine vertrauenswürdige Baseline. Bei Deployment mitten in der Ladung
    // bleibt sessionStartEto bewusst null → wh-Fallback beim Abschluss.
    if (!sessionSeenCharging) {
      sessionStartEto = prev.lastCar === 1 && Number.isSafeInteger(idleEto) ? idleEto : null;
      sessionSeenCharging = true;
    }
  } else if (car === 1) {
    if (sessionSeenCharging && Number.isSafeInteger(sessionStartEto) && totalWh >= sessionStartEto) {
      completed = {
        startEto: sessionStartEto,
        endEto: totalWh,
        energyWh: totalWh - sessionStartEto,
      };
    }

    // Idle ist die Baseline der nächsten Session. Damit heilt sich der Zustand
    // auch nach Reboot oder einem nicht importierbaren Endzeitpunkt selbst.
    idleEto = totalWh;
    sessionStartEto = null;
    sessionSeenCharging = false;
  }

  return {
    state: {
      version: 1,
      serial,
      lastCar: car,
      lastEto: totalWh,
      idleEto,
      sessionStartEto,
      sessionSeenCharging,
      updatedAt: observedAt,
    },
    completed,
    reset: false,
  };
}

export function chooseSessionEnergy(completed, wh) {
  if (completed && Number.isSafeInteger(completed.energyWh) && completed.energyWh >= 10) {
    return {
      energyWh: completed.energyWh,
      source: 'eto-delta',
      meterStartWh: completed.startEto,
      meterEndWh: completed.endEto,
    };
  }

  const whValue = typeof wh === 'number' && Number.isFinite(wh) ? wh : NaN;
  if (whValue >= 10) {
    return {
      energyWh: whValue,
      source: 'wh-fallback',
      meterStartWh: null,
      meterEndWh: completed?.endEto ?? null,
    };
  }

  return null;
}
