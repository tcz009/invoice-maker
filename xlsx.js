'use strict';

/* =====================================================================
   Minimal .xlsx writer for the invoice sheet.
   No dependencies: builds the workbook parts by hand and wraps them in a
   stored (uncompressed) ZIP. The layout mirrors the printed invoice.
   ===================================================================== */

const InvoiceXLSX = (() => {
  const encoder = new TextEncoder();

  const STYLE = {
    default: 0,
    title: 1,
    band: 2,
    label: 3,
    value: 4,
    valueRight: 5,
    header: 6,
    cell: 7,
    cellWrap: 8,
    money: 9,
    moneyBold: 10,
    subtotalLabel: 11,
    totalLabel: 12,
    totalMoney: 13,
    cert: 14,
    submission: 15,
    date: 16,
    valuePlain: 17,
  };

  const COLS = { B: 2, C: 3, D: 4, E: 5, F: 6 };

  /* ---------------- helpers ---------------- */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function colLetter(index) {
    let out = '';
    let n = index;
    while (n > 0) {
      const rest = (n - 1) % 26;
      out = String.fromCharCode(65 + rest) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }

  function toNumber(value) {
    const n = Number(String(value == null ? '' : value).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
  }

  function parseDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function excelSerial(value) {
    const d = parseDate(value);
    if (!d) return null;
    return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);
  }

  function currencySymbol(code) {
    return { GBP: '£', EUR: '€', USD: '$' }[code] || '';
  }

  /* ---------------- sheet model ---------------- */

  function createSheet() {
    const cells = new Map();
    const merges = [];

    const put = (row, col, xml) => {
      if (!cells.has(row)) cells.set(row, new Map());
      cells.get(row).set(col, xml);
    };

    const ref = (row, col) => `${colLetter(col)}${row}`;

    const api = {
      text(row, col, style, value) {
        const r = ref(row, col);
        if (value === '' || value == null) {
          put(row, col, `<c r="${r}" s="${style}" t="inlineStr"><is><t/></is></c>`);
        } else {
          put(row, col, `<c r="${r}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`);
        }
      },
      number(row, col, style, value) {
        if (value == null || Number.isNaN(value)) return;
        put(row, col, `<c r="${ref(row, col)}" s="${style}"><v>${value}</v></c>`);
      },
      formula(row, col, style, formula, cached) {
        const value = cached == null ? '' : `<v>${cached}</v>`;
        put(row, col, `<c r="${ref(row, col)}" s="${style}"><f>${esc(formula)}</f>${value}</c>`);
      },
      merge(range) {
        merges.push(range);
      },
      rowsXml(heights) {
        const list = Array.from(cells.keys()).sort((a, b) => a - b);
        return list
          .map((row) => {
            const ordered = Array.from(cells.get(row).keys()).sort((a, b) => a - b);
            const body = ordered.map((col) => cells.get(row).get(col)).join('');
            const height = heights && heights[row] ? ` ht="${heights[row]}" customHeight="1"` : '';
            return `<row r="${row}"${height}>${body}</row>`;
          })
          .join('');
      },
      mergesXml() {
        return merges.map((range) => `<mergeCell ref="${range}"/>`).join('');
      },
    };

    return api;
  }

  /* ---------------- invoice → sheet ---------------- */

  function buildSheet(inv) {
    const sheet = createSheet();
    const symbol = currencySymbol(inv.currency);
    const bandFill = STYLE.band;

    // title
    sheet.text(1, COLS.B, STYLE.title, 'Independent Contractor Invoice');
    sheet.merge('B1:F1');

    // details band
    sheet.text(4, COLS.B, STYLE.band, 'Contractor & Invoice Details');
    sheet.merge('B4:F4');

    const details = [
      [5, 'Contractor Name', inv.contractor.name, 'Invoice Number', inv.number],
      [6, 'Business Name (if applicable)', inv.contractor.business, 'Invoice Date', inv.issueDate],
      [7, 'Email', inv.contractor.email, 'UTR Number', inv.contractor.utr],
      [8, 'Phone', inv.contractor.phone, 'Due Date', inv.dueDate],
    ];

    details.forEach(([row, leftLabel, leftValue, rightLabel, rightValue]) => {
      sheet.text(row, COLS.B, STYLE.label, leftLabel);
      sheet.text(row, COLS.C, STYLE.value, leftValue);
      sheet.merge(`C${row}:D${row}`);
      sheet.text(row, COLS.E, STYLE.label, rightLabel);
      if (rightLabel === 'Invoice Date' || rightLabel === 'Due Date') {
        const serial = excelSerial(rightValue);
        if (serial != null) sheet.number(row, COLS.F, STYLE.date, serial);
        else sheet.text(row, COLS.F, STYLE.value, '');
      } else {
        sheet.text(row, COLS.F, STYLE.value, rightValue);
      }
    });

    sheet.text(9, COLS.B, STYLE.label, 'Address');
    sheet.text(9, COLS.C, STYLE.cellWrap, inv.contractor.address);
    sheet.merge('C9:D9');

    // services band + header
    sheet.text(12, COLS.B, STYLE.band, 'Services Provided');
    sheet.merge('B12:F12');

    ['Date', 'Description of Work', 'Hours / Qty', 'Rate', 'Amount'].forEach((label, index) => {
      sheet.text(13, COLS.B + index, STYLE.header, label);
    });

    // items
    const items = inv.items.length ? inv.items : [{ date: '', description: '', qty: '', rate: '' }];
    const firstItemRow = 14;
    let totalCents = 0;

    items.forEach((item, index) => {
      const row = firstItemRow + index;
      sheet.text(row, COLS.B, STYLE.cell, item.date);
      sheet.text(row, COLS.C, STYLE.cell, item.description);
      sheet.number(row, COLS.D, STYLE.valueRight, toNumber(item.qty));
      sheet.number(row, COLS.E, STYLE.money, Number(toNumber(item.rate).toFixed(2)));

      const cents = Math.round(toNumber(item.qty) * toNumber(item.rate) * 100);
      totalCents += cents;
      const amount = (cents / 100).toFixed(2);
      sheet.formula(
        row,
        COLS.F,
        STYLE.money,
        `IF(OR(D${row}="",E${row}=""),"",D${row}*E${row})`,
        item.rate === '' ? null : amount,
      );
    });

    const lastItemRow = firstItemRow + items.length - 1;
    const subtotalRow = lastItemRow + 1;
    const totalRow = subtotalRow + 3;
    const paymentRow = totalRow + 2;
    const certRow = paymentRow + 6;

    // subtotal + total
    sheet.text(subtotalRow, COLS.E, STYLE.subtotalLabel, 'Subtotal');
    sheet.formula(subtotalRow, COLS.F, STYLE.moneyBold, `SUM(F${firstItemRow}:F${lastItemRow})`, (totalCents / 100).toFixed(2));

    sheet.text(totalRow, COLS.B, STYLE.totalLabel, 'TOTAL AMOUNT DUE');
    sheet.merge(`B${totalRow}:E${totalRow}`);
    sheet.formula(totalRow, COLS.F, STYLE.totalMoney, `F${subtotalRow}`, (totalCents / 100).toFixed(2));

    // payment details
    sheet.text(paymentRow, COLS.B, STYLE.band, 'Payment Details');
    sheet.merge(`B${paymentRow}:F${paymentRow}`);

    const payment = [
      ['Bank Name', inv.payment.bank],
      ['Account Holder Name', inv.payment.holder],
      ['Account Number', inv.payment.accountNumber],
      ['Sort Code', inv.payment.sortCode],
    ];
    payment.forEach(([label, value], index) => {
      const row = paymentRow + 1 + index;
      sheet.text(row, COLS.B, STYLE.label, label);
      sheet.text(row, COLS.C, STYLE.value, value);
      sheet.merge(`C${row}:F${row}`);
    });

    // certification, submission, signature
    sheet.text(certRow, COLS.B, STYLE.cert, inv.certification);
    sheet.merge(`B${certRow}:F${certRow}`);

    sheet.text(certRow + 1, COLS.B, STYLE.submission, inv.submission);
    sheet.merge(`B${certRow + 1}:F${certRow + 1}`);

    sheet.text(certRow + 2, COLS.B, STYLE.label, 'Signature');
    sheet.text(certRow + 2, COLS.C, STYLE.value, inv.signature);
    sheet.merge(`C${certRow + 2}:D${certRow + 2}`);
    sheet.text(certRow + 2, COLS.E, STYLE.label, 'Date');
    const signatureSerial = excelSerial(inv.signatureDate);
    if (signatureSerial != null) sheet.number(certRow + 2, COLS.F, STYLE.date, signatureSerial);
    else sheet.text(certRow + 2, COLS.F, STYLE.value, '');

    return {
      sheet,
      firstItemRow,
      lastItemRow,
      subtotalRow,
      totalRow,
      paymentRow,
      certRow,
      symbol,
      bandFill,
    };
  }

  /* ---------------- workbook parts ---------------- */

  function stylesXml(symbol) {
    const fonts = [
      '<font><sz val="10"/><name val="Arial"/></font>',
      '<font><b/><sz val="13"/><name val="Arial"/></font>',
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>',
      '<font><sz val="10"/><color rgb="FF595959"/><name val="Arial"/></font>',
      '<font><b/><sz val="10"/><name val="Arial"/></font>',
      '<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>',
      '<font><i/><sz val="9"/><color rgb="FF595959"/><name val="Arial"/></font>',
      '<font><b/><sz val="11"/><name val="Arial"/></font>',
    ];

    const fills = [
      '<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>',
      '<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>',
      '<fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill>',
    ];

    const border =
      '<border><left style="thin"><color rgb="FF9AA0A8"/></left><right style="thin"><color rgb="FF9AA0A8"/></right>' +
      '<top style="thin"><color rgb="FF9AA0A8"/></top><bottom style="thin"><color rgb="FF9AA0A8"/></bottom><diagonal/></border>';

    const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>', border];

    const xf = (numFmt, font, fill, borderId, alignment) =>
      `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${borderId}" xfId="0" applyFont="1"` +
      `${fill ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${numFmt ? ' applyNumberFormat="1"' : ''}` +
      `${alignment ? ' applyAlignment="1"' : ''}>${alignment || ''}</xf>`;

    const left = '<alignment horizontal="left" vertical="center"/>';
    const centre = '<alignment horizontal="center" vertical="center" wrapText="1"/>';
    const right = '<alignment horizontal="right" vertical="center"/>';
    const topLeft = '<alignment horizontal="left" vertical="top" wrapText="1"/>';

    const xfs = [
      xf(0, 0, 0, 0, left),                          // 0 default
      xf(0, 1, 0, 0, left),                          // 1 title
      xf(0, 2, 2, 0, left),                          // 2 band
      xf(0, 3, 0, 0, left),                          // 3 label
      xf(0, 0, 0, 1, left),                          // 4 value
      xf(0, 0, 0, 1, right),                         // 5 value right
      xf(0, 4, 3, 1, centre),                        // 6 table header
      xf(0, 0, 0, 1, topLeft),                       // 7 cell
      xf(0, 0, 0, 1, topLeft),                       // 8 cell wrap
      xf(164, 0, 0, 1, right),                       // 9 money
      xf(164, 4, 0, 1, right),                       // 10 money bold
      xf(0, 4, 0, 1, right),                         // 11 subtotal label
      xf(0, 5, 2, 0, right),                         // 12 total label
      xf(164, 5, 2, 0, right),                       // 13 total money
      xf(0, 6, 0, 0, topLeft),                       // 14 certification
      xf(0, 7, 0, 0, left),                          // 15 submission
      xf(165, 0, 0, 1, right),                       // 16 date
      xf(0, 0, 0, 0, left),                          // 17 plain value
    ];

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="164" formatCode="${symbol}#,##0.00;(${symbol}#,##0.00)"/>
<numFmt numFmtId="165" formatCode="dd/mm/yyyy"/>
</numFmts>
<fonts count="${fonts.length}">${fonts.join('')}</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="${borders.length}">${borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }

  function sheetXml(sheet, heights) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>
<col min="1" max="1" width="3" customWidth="1"/>
<col min="2" max="2" width="28" customWidth="1"/>
<col min="3" max="3" width="22" customWidth="1"/>
<col min="4" max="4" width="14" customWidth="1"/>
<col min="5" max="5" width="16" customWidth="1"/>
<col min="6" max="6" width="18" customWidth="1"/>
</cols>
<sheetData>${sheet.rowsXml(heights)}</sheetData>
<mergeCells count="${sheet.mergesXml().split('<mergeCell').length - 1}">${sheet.mergesXml()}</mergeCells>
</worksheet>`;
  }

  /* ---------------- ZIP ---------------- */

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }

  function zip(files) {
    const chunks = [];
    const central = [];
    const stamp = dosDateTime(new Date());
    let offset = 0;

    files.forEach(({ name, data }) => {
      const nameBytes = encoder.encode(name);
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      const entry = new Uint8Array(46 + nameBytes.length);
      const ev = new DataView(entry.buffer);
      ev.setUint32(0, 0x02014b50, true);
      ev.setUint16(4, 20, true);
      ev.setUint16(6, 20, true);
      ev.setUint16(8, 0x0800, true);
      ev.setUint16(10, 0, true);
      ev.setUint16(12, stamp.time, true);
      ev.setUint16(14, stamp.date, true);
      ev.setUint32(16, crc, true);
      ev.setUint32(20, data.length, true);
      ev.setUint32(24, data.length, true);
      ev.setUint16(28, nameBytes.length, true);
      ev.setUint16(30, 0, true);
      ev.setUint16(32, 0, true);
      ev.setUint16(34, 0, true);
      ev.setUint16(36, 0, true);
      ev.setUint32(38, 0, true);
      ev.setUint32(42, offset, true);
      entry.set(nameBytes, 46);

      chunks.push(local, data);
      central.push(entry);
      offset += local.length + data.length;
    });

    const centralSize = central.reduce((sum, item) => sum + item.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);

    const all = [...chunks, ...central, end];
    const size = all.reduce((sum, item) => sum + item.length, 0);
    const output = new Uint8Array(size);
    let position = 0;
    all.forEach((item) => {
      output.set(item, position);
      position += item.length;
    });
    return output;
  }

  /* ---------------- public ---------------- */

  function build(inv) {
    const { sheet, firstItemRow, lastItemRow, subtotalRow, totalRow, paymentRow, certRow } = buildSheet(inv);

    const heights = { 1: 22, 4: 22, 9: 30, 12: 22, 13: 18 };
    for (let row = firstItemRow; row <= lastItemRow; row += 1) heights[row] = 22;
    heights[subtotalRow] = 20;
    heights[totalRow] = 24;
    heights[paymentRow] = 22;
    for (let row = paymentRow + 1; row <= paymentRow + 4; row += 1) heights[row] = 18;
    heights[certRow] = 42;
    heights[certRow + 1] = 24;
    heights[certRow + 2] = 20;

    const parts = {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Invoice" sheetId="1" r:id="rId1"/></sheets>
<calcPr calcId="0" fullCalcOnLoad="1"/>
</workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
      'xl/worksheets/sheet1.xml': sheetXml(sheet, heights),
      'xl/styles.xml': stylesXml(currencySymbol(inv.currency)),
    };

    return zip(
      Object.keys(parts).map((name) => ({ name, data: encoder.encode(parts[name]) })),
    );
  }

  return { build };
})();

if (typeof window !== 'undefined') window.InvoiceXLSX = InvoiceXLSX;
