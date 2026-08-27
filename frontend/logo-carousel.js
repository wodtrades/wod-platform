/* WOD - rotating promo bar (one firm at a time, swipes to the next).
   Add to any page with:  <script src="logo-carousel.js" defer></script>
   Self-contained (injects its own styles + markup, no dependencies).
   Rotates with a horizontal SWIPE: the current deal slides out to the left
   while the next slides in from the right (two absolutely-placed slides
   inside an overflow-clipped, fixed-height strip, so nothing ever jumps or
   overlaps). The whole bar is one clickable link to the current firm. */
(function () {
  'use strict';

  var DEALS = [
    { firm: 'Lucid Trading', off: '40% off', logo: 'assets/lucid-logo.webp',        url: 'https://lucidtrading.com/ref/wod' },
    { firm: 'Tradeify',      off: '40% off', logo: 'assets/tradeify-logo.jpg',      url: 'https://tradeify.co/?ref=WOD' },
    { firm: 'Alpha Futures', off: '40% off', logo: 'assets/alphafutures-logo.jpg',  url: 'https://app.alpha-futures.com/signup/WOD/' }
  ];

  if (!DEALS.length) return;

  function build() {
    var mount = document.getElementById('logoCarousel');
    if (!mount || mount.dataset.built) return;
    mount.dataset.built = '1';

    var css = document.createElement('style');
    css.textContent = [
      '#logoCarousel{position:relative;z-index:10;overflow:hidden;min-height:44px;',
        'background:var(--bg-panel);border-bottom:1px solid var(--border)}',
      '#logoCarousel .lgc-slide{position:absolute;top:0;left:0;right:0;bottom:0;',
        'display:flex;align-items:center;justify-content:center;flex-wrap:nowrap;gap:9px;',
        'box-sizing:border-box;padding:9px 16px;text-align:center;text-decoration:none;',
        'color:var(--text-primary);font-size:14px;font-weight:600;line-height:1.3;cursor:pointer;',
        'will-change:transform;transform:translateX(100%)}',
      '#logoCarousel .lgc-logo{width:20px;height:20px;border-radius:4px;object-fit:contain;flex:none}',
      '#logoCarousel .lgc-off{color:var(--accent-gold);font-weight:800}',
      '#logoCarousel .lgc-code{color:var(--bg);font-weight:800;background:var(--accent-gold);',
        'border-radius:6px;padding:1px 7px;letter-spacing:0.03em}',
      '@media(max-width:480px){#logoCarousel{min-height:50px}',
        '#logoCarousel .lgc-slide{font-size:12.5px;gap:7px;padding:6px 12px}',
        '#logoCarousel .lgc-logo{width:18px;height:18px}}'
    ].join('');
    document.head.appendChild(css);

    function makeSlide() {
      var a = document.createElement('a');
      a.className = 'lgc-slide';
      a.target = '_blank';
      a.rel = 'noopener sponsored';
      return a;
    }
    var cur = makeSlide(), nxt = makeSlide();
    mount.appendChild(nxt);
    mount.appendChild(cur); // cur last in DOM = on top, so clicks hit the visible deal

    function paint(el, d) {
      el.href = d.url;
      el.innerHTML =
        '<img class="lgc-logo" src="' + d.logo + '" alt="">' +
        '<span><b>' + d.firm + '</b> is <span class="lgc-off">' + d.off +
        '</span> with code <span class="lgc-code">WOD</span></span>';
    }

    var i = 0;
    paint(cur, DEALS[0]);
    cur.style.transform = 'translateX(0)'; // current sits centered; nxt stays off-screen right

    if (DEALS.length < 2) return;

    var animating = false, paused = false, reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion:reduce)').matches; } catch (e) {}
    mount.addEventListener('mouseenter', function () { paused = true; });
    mount.addEventListener('mouseleave', function () { paused = false; });

    setInterval(function () {
      if (paused || animating) return;
      var n = (i + 1) % DEALS.length;
      paint(nxt, DEALS[n]);

      if (reduce) { paint(cur, DEALS[n]); i = n; return; }

      // park the incoming slide off-screen right with no transition, then swipe both left
      nxt.style.transition = 'none';
      nxt.style.transform = 'translateX(100%)';
      void nxt.offsetWidth; // reflow so the next lines animate

      animating = true;
      var ease = 'transform .55s cubic-bezier(.45,0,.15,1)';
      cur.style.transition = ease;
      nxt.style.transition = ease;
      cur.style.transform = 'translateX(-100%)'; // current exits to the left
      nxt.style.transform = 'translateX(0)';     // next enters from the right

      var done = false;
      function finish() {
        if (done) return; done = true;
        cur.style.transition = 'none';
        cur.style.transform = 'translateX(100%)'; // recycle the old slide to the right
        var tmp = cur; cur = nxt; nxt = tmp;       // swap roles
        mount.appendChild(cur);                    // new current on top for clicks
        i = n;
        animating = false;
      }
      nxt.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 700); // fallback if transitionend is missed
    }, 4000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
