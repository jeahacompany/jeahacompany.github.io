/* 창고(EZSTORAGE) → 도반글로벌 B2B 수집기
 *
 * 매일 직원이 3PL 사이트에서 엑셀 두 개(재고 요약본 / 입출고 현황)를 내려받아
 * 업로드하던 일을 없애기 위한 것. 사람이 파일을 옮기는 단계만 뺀다.
 *
 * 하는 일은 **읽기뿐**이다. EZSTORAGE 에 아무것도 쓰지 않는다.
 * 비밀번호·토큰을 저장하지 않는다 — 이미 로그인된 브라우저 세션을 그대로 쓴다.
 * 우리 앱으로는 창을 하나 열어 postMessage 로 넘긴다.
 *   → 그래야 우리 앱 로그인 정보가 이 파일 안에 들어오지 않는다.
 *
 * ⚠ 푸드시그널(erp)도 같은 EZSTORAGE 를 쓰지만 **판매자 계정이 다르다.**
 *   같은 github.io 도메인에 두 앱이 있으므로 origin 만으로는 구분이 안 된다.
 *   그래서 메시지 이름을 B2B_WMS_* 로 따로 쓴다 (erp 쪽은 EZ_*).
 */
(function () {
  'use strict';

  var APP_ORIGIN = 'https://jeahacompany.github.io';
  var APP_URL = APP_ORIGIN + '/b2b/?wms=1';
  var API = 'https://api.ezstorage.io/';
  // 며칠치 입출고를 가져올지. 처음 한 번은 길게(95) 잡아 과거를 채우고, 평소엔 30.
  var DAYS = (window.__wmsDays && Number(window.__wmsDays)) || 30;

  if (window.__wmsRunning) return;
  window.__wmsRunning = true;
  window.__wmsResult = { state: 'running', at: new Date().toISOString() };
  function finish(ok, msg, counts) {
    window.__wmsResult = { state: ok ? 'ok' : 'error', msg: msg, counts: counts || null,
                           at: new Date().toISOString() };
  }

  // ── 진행 상황 상자 ────────────────────────────────────────────────────
  var box = document.createElement('div');
  box.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:330px;' +
    'background:#fff;border:1px solid #cbd5e1;border-radius:12px;padding:14px 16px;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.18);' +
    'font:13px/1.6 -apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif;color:#0f172a';
  box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">도반 B2B로 보내기</div>' +
                  '<div id="wms-msg">준비 중…</div>';
  document.body.appendChild(box);
  var msgEl = box.querySelector('#wms-msg');
  function say(t) { msgEl.innerHTML = t; }
  function done(t, bad) {
    say('<span style="color:' + (bad ? '#dc2626' : '#15803d') + '">' + t + '</span>');
    setTimeout(function () { box.remove(); window.__wmsRunning = false; }, bad ? 12000 : 6000);
  }

  // ⚠ 인증 헤더를 **우리가 만들지 않는다.**
  //   토큰을 직접 만들어 보내면 서버가 401 을 주고, 그 401 을 받은 EZSTORAGE 앱이
  //   사용자를 로그아웃시켜 버린다. 그래서 앱이 스스로 보내는 요청의 헤더를 빌려 쓴다.
  //   헤더를 못 구하면 **요청을 아예 보내지 않고 멈춘다.**
  var HDR = null;

  function captureHeaders(waitMs) {
    if (HDR) return Promise.resolve(HDR);
    return new Promise(function (resolve) {
      var orig = window.fetch, settled = false;
      function stop(h) {
        if (settled) return;
        settled = true; window.fetch = orig; HDR = h; resolve(h);
      }
      window.fetch = function (i, init) {
        try {
          var u = typeof i === 'string' ? i : (i && i.url) || '';
          if (/api\.ezstorage\.io/.test(u)) {
            var h = (init && init.headers) || (i && i.headers);
            if (h) {
              var o = {};
              if (typeof h.forEach === 'function') h.forEach(function (v, k) { o[k] = v; });
              else Object.keys(h).forEach(function (k) { o[k] = h[k]; });
              if (o['x-xsrf-token']) stop(o);
            }
          }
        } catch (e) { /* 관찰만 한다. 앱 동작을 막지 않는다 */ }
        return orig.apply(this, arguments);
      };
      try { window.dispatchEvent(new Event('focus')); } catch (e) {}
      try {
        var ac = window.__APOLLO_CLIENT__;
        if (ac && typeof ac.getObservableQueries === 'function') {
          ac.getObservableQueries().forEach(function (q) { try { q.refetch(); } catch (e) {} });
        }
      } catch (e) {}
      setTimeout(function () { stop(null); }, waitMs || 15000);
    });
  }

  function gql(query, variables) {
    if (!HDR) return Promise.reject(new Error('EZ_NO_HEADERS'));
    var headers = { 'content-type': 'application/json' };
    Object.keys(HDR).forEach(function (k) { headers[k] = HDR[k]; });
    return fetch(API, {
      method: 'POST', credentials: 'include', headers: headers,
      body: JSON.stringify({ query: query, variables: variables || {} })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
        return j.data;
      });
  }

  function kstDate(d) {
    return new Date((d ? d.getTime() : Date.now()) + 9 * 3600e3).toISOString().slice(0, 10);
  }
  function iso(daysAgo) { return new Date(Date.now() - daysAgo * 864e5).toISOString(); }

  var ids = {};

  // ── 1. 어느 창고·어느 판매자인지 스스로 찾는다 (하드코딩하지 않는다) ──
  function findIds() {
    say('계정 확인 중…');
    return gql('query{ logistics { id } }')
      .then(function (d) {
        if (!d.logistics || !d.logistics.length) throw new Error('창고 정보를 찾지 못했습니다');
        ids.logisticId = d.logistics[0].id;
        return gql('query S($l:ID!){ sellers(logisticId:$l){ id name } }', { l: ids.logisticId });
      })
      .then(function (d) {
        if (!d.sellers || !d.sellers.length) throw new Error('판매자 정보를 찾지 못했습니다');
        ids.sellerId = d.sellers[0].id;
        ids.sellerName = d.sellers[0].name || '';
        // 계정에 판매자가 여럿이면 어느 것을 읽었는지 화면에 밝힌다.
        // (법인이 섞이면 안 되므로 사람이 눈으로 확인할 수 있어야 한다)
        ids.sellerCount = d.sellers.length;
      });
  }

  // ── 2. 재고 (상품표도 여기서 같이 만든다) ─────────────────────────────
  // 입출고 조회에는 고객사 상품코드가 안 내려온다. 재고 조회에는 내려온다.
  // 그래서 여기서 code ↔ sku 를 이어두고, 입출고는 code 로 붙인다.
  function fetchStock() {
    say('재고 읽는 중…');
    return gql(
      'query INV($i: GetProductInventoriesInput!){ getProductInventories(input:$i){ totalCount' +
        ' productOptions { totalUsable totalBroken' +
        ' productOption { systemProductCode customerProductCode barcode levelOne levelTwo isActive' +
        ' product { name } } } } }',
      { i: { inventoryArgsWithPagination: {
          logisticId: ids.logisticId, sellerId: ids.sellerId,
          endDate: new Date().toISOString(), take: 1000, skip: 0 } } }
    ).then(function (d) {
      var products = [], stock = [];
      (d.getProductInventories.productOptions || []).forEach(function (o) {
        var po = o.productOption || {};
        var code = po.systemProductCode;
        if (!code) return;
        var nm = (po.product && po.product.name) || '';
        var opt = [po.levelOne, po.levelTwo].filter(Boolean).join(' / ');
        products.push({ code: code, sku: po.customerProductCode || '', name: nm,
                        option: opt, barcode: po.barcode || '' });
        stock.push({ code: code, sku: po.customerProductCode || '', name: nm, option: opt,
                     barcode: po.barcode || '',
                     avail: o.totalUsable || 0, bad: o.totalBroken || 0 });
      });
      return { products: products, stock: stock };
    });
  }

  // ── 3. 입출고 (상품 × 날짜 × 방향) ────────────────────────────────────
  function fetchMoves(skuOf) {
    var range = { from: iso(DAYS), to: new Date().toISOString() };
    var q =
      'query IO($l:NonEmptyId!,$s:NonEmptyId!,$d:DateRange!,$t:InboundOutboundType!){' +
      ' inboundOutboundByProduct(logisticId:$l, sellerId:$s, inquiryDate:$d,' +
      ' inboundOutboundType:$t, take:1000, skip:0){ totalCount' +
      ' data { systemProductCode customerProductCode' +
      ' quantityDataByDate { date usable broken } } } }';
    var rows = [];
    function one(dir) {
      say('입출고 읽는 중… (' + (dir === 'IN' ? '입고' : '출고') + ')');
      return gql(q, { l: ids.logisticId, s: ids.sellerId, d: range, t: dir }).then(function (d) {
        (d.inboundOutboundByProduct.data || []).forEach(function (r) {
          if (!r.systemProductCode) return;
          (r.quantityDataByDate || []).forEach(function (q2) {
            if (!q2 || !q2.date) return;
            var qty = q2.usable || 0;
            if (!qty) return;
            rows.push({
              move_date: kstDate(new Date(q2.date)),
              code: r.systemProductCode,
              // 입출고에는 고객사코드가 안 오므로 재고에서 만든 표로 메운다
              sku: r.customerProductCode || skuOf[r.systemProductCode] || '',
              kind: dir === 'IN' ? 'in' : 'out',
              qty: qty
            });
          });
        });
      });
    }
    return one('IN').then(function () { return one('OUT'); }).then(function () {
      // 같은 날·같은 상품·같은 방향이 여러 줄로 오면 합친다
      var m = {};
      rows.forEach(function (r) {
        var k = r.move_date + '|' + r.code + '|' + r.kind;
        if (!m[k]) m[k] = r; else m[k].qty += r.qty;
      });
      return Object.keys(m).map(function (k) { return m[k]; });
    });
  }

  // ── 4. 우리 앱 창을 열어 넘긴다 ───────────────────────────────────────
  function send(payload) {
    say('B2B 창으로 보내는 중…');
    var w = window.open(APP_URL, 'b2b_wms_receiver');
    if (!w) {
      finish(false, '팝업 차단됨');
      done('팝업이 막혔습니다. 주소창 오른쪽에서 팝업을 허용한 뒤 다시 눌러주세요.', true);
      return;
    }
    var sent = false, timer = null;
    function cleanup() { window.removeEventListener('message', onMsg); clearTimeout(timer); }
    function onMsg(e) {
      if (e.origin !== APP_ORIGIN || !e.data) return;
      if (e.data.type === 'B2B_WMS_READY' && !sent) {
        sent = true;
        (e.source || w).postMessage({ type: 'B2B_WMS_DATA', payload: payload }, APP_ORIGIN);
      } else if (e.data.type === 'B2B_WMS_SAVED') {
        var r = e.data.result || {};
        cleanup();
        finish(true, '저장 완료', r);
        done('보냈습니다 · 재고 ' + ((r.stock && r.stock.total) || 0) + '건 · 입출고 ' +
             ((r.moves && r.moves.total) || 0) + '건');
      } else if (e.data.type === 'B2B_WMS_ERROR') {
        var m = e.data.message || '알 수 없는 오류';
        cleanup();
        finish(false, 'B2B: ' + m);
        done('B2B 쪽에서 막혔습니다: ' + m, true);
      }
    }
    window.addEventListener('message', onMsg);
    timer = setTimeout(function () {
      cleanup();
      finish(false, 'B2B 가 응답하지 않음 (로그인 확인 필요)');
      done('B2B가 응답하지 않습니다. 관리자로 로그인돼 있는지 확인해주세요.', true);
    }, 90000);
  }

  // ── 실행 ──────────────────────────────────────────────────────────────
  var payload = { collected_at: new Date().toISOString(), stock_date: kstDate(), days: DAYS };
  say('EZSTORAGE 화면이 쓰는 인증을 확인하는 중…');
  captureHeaders(15000)
    .then(function (h) {
      if (!h) {
        var e = new Error('EZSTORAGE 화면에서 조회를 한 번 해주세요 (인증을 확인하지 못했습니다)');
        e.code = 'EZ_NO_HEADERS';
        throw e;
      }
    })
    .then(findIds)
    .then(fetchStock)
    .then(function (r) {
      payload.products = r.products;
      payload.stock = r.stock;
      payload.seller = ids.sellerName;
      payload.seller_count = ids.sellerCount;
      var skuOf = {};
      r.products.forEach(function (p) { if (p.sku) skuOf[p.code] = p.sku; });
      return fetchMoves(skuOf);
    })
    .then(function (r) { payload.moves = r; })
    .then(function () {
      say('읽기 완료 · 상품 ' + payload.products.length + ' · 재고 ' + payload.stock.length +
          ' · 입출고 ' + payload.moves.length +
          (ids.sellerCount > 1 ? '<br><b style="color:#b45309">판매자가 ' + ids.sellerCount +
           '개입니다 — "' + (ids.sellerName || '첫 번째') + '" 것을 읽었습니다</b>' : ''));
      window.__wmsPayload = payload;
      send(payload);
    })
    .catch(function (e) {
      var m = String((e && e.message) || e);
      if (/승인되지|Unauthorized|401/i.test(m)) {
        finish(false, 'EZSTORAGE 로그인 풀림');
        done('EZSTORAGE 로그인이 풀렸습니다. 다시 로그인한 뒤 눌러주세요.', true);
      } else {
        finish(false, m);
        done('읽지 못했습니다: ' + m, true);
      }
    });
})();
