/**
 * Facturación: se factura todo equipo que estuvo registrado al menos un día del mes.
 * Cada día se anota qué equipos existen (billing_days). Al empezar un mes, el anterior se cierra
 * en billing_months y ese número ya no cambia.
 */
export function createBilling(db, { now, timezone }) {
  const q = (sql) => db.prepare(sql);

  /** Fecha local del sistema de facturación, por ejemplo 2026-11-25. */
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: timezone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()));
  const currentMonth = () => today().slice(0, 7);

  const recordStmt = q(`INSERT INTO billing_days (company_id, device_id, day, device_name) VALUES (?,?,?,?)
                        ON CONFLICT (company_id, device_id, day) DO UPDATE SET device_name = excluded.device_name`);

  /** Anota un equipo hoy. Se llama al darse de alta, así cuenta aunque se borre antes del próximo ciclo. */
  const recordDevice = (companyId, deviceId, name) => recordStmt.run(companyId, deviceId, today(), name);

  function recordAll() {
    const day = today();
    db.exec('BEGIN');
    try {
      for (const d of q('SELECT id, company_id, name FROM devices').all()) recordStmt.run(d.company_id, d.id, day, d.name);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Cierra los meses anteriores al actual que todavía no estén cerrados. */
  function closeMonths() {
    const month = currentMonth();
    const open = q(`SELECT company_id, substr(day, 1, 7) AS month, COUNT(DISTINCT device_id) AS n
                    FROM billing_days WHERE substr(day, 1, 7) < ?
                    GROUP BY company_id, substr(day, 1, 7)`).all(month);
    const ins = q('INSERT OR IGNORE INTO billing_months (company_id, month, devices, closed_at) VALUES (?,?,?,?)');
    for (const r of open) ins.run(r.company_id, r.month, r.n, now());
    // El detalle diario se conserva 13 meses para poder justificar una factura.
    const [y, m] = month.split('-').map(Number);
    const cutoff = `${y - 1}-${String(m).padStart(2, '0')}`;
    q('DELETE FROM billing_days WHERE substr(day, 1, 7) < ?').run(cutoff);
  }

  function tick() {
    recordAll();
    closeMonths();
  }

  const isClosed = (month) => month < currentMonth();

  /** Equipos facturables por empresa en un mes: el número cerrado, o el conteo en curso. */
  function monthCounts(month) {
    const counts = new Map();
    if (isClosed(month)) {
      for (const r of q('SELECT company_id, devices FROM billing_months WHERE month=?').all(month)) counts.set(r.company_id, r.devices);
    } else {
      for (const r of q(`SELECT company_id, COUNT(DISTINCT device_id) AS n FROM billing_days WHERE substr(day, 1, 7) = ? GROUP BY company_id`).all(month)) {
        counts.set(r.company_id, r.n);
      }
    }
    return counts;
  }

  function months() {
    const set = new Set([currentMonth()]);
    for (const r of q('SELECT DISTINCT month FROM billing_months').all()) set.add(r.month);
    return [...set].sort().reverse();
  }

  /** Detalle por equipo de una empresa en un mes: primer y último día registrado. */
  const deviceDetail = (companyId, month) => q(`SELECT device_id AS deviceId, MAX(device_name) AS name, MIN(day) AS firstDay, MAX(day) AS lastDay, COUNT(*) AS days
      FROM billing_days WHERE company_id=? AND substr(day, 1, 7)=? GROUP BY device_id ORDER BY name`).all(companyId, month);

  return { today, currentMonth, recordDevice, tick, monthCounts, months, isClosed, deviceDetail };
}
