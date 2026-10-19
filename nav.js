// Barre latérale commune : Alimentation, Posture, Tennis.
(function () {
  var root = document.documentElement;
  if (!root.hasAttribute('data-theme-lock')) {
    var t = null;
    try { t = localStorage.getItem('theme'); } catch (e) { /* stockage indisponible */ }
    root.setAttribute('data-theme', t || root.getAttribute('data-theme') || 'light');
  }

  var ICONS = {
    food: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="7"/><path d="M12 6V3M9 13h6"/></svg>',
    posture: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="4.5" r="2"/><path d="M12 7.5v7M8 10.5h8M12 14.5l-3 6M12 14.5l3 6"/></svg>',
    tennis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M5.5 6.5c3 2.5 3 8.5 0 11M18.5 6.5c-3 2.5-3 8.5 0 11"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>'
  };
  var PAGES = [
    { href: './', file: 'index.html', label: 'Alimentation', icon: 'food' },
    { href: 'posture.html', file: 'posture.html', label: 'Posture', icon: 'posture' },
    { href: 'tennis.html', file: 'tennis.html', label: 'Tennis', icon: 'tennis' }
  ];
  var here = location.pathname.split('/').pop() || 'index.html';

  function build() {
    var nav = document.createElement('aside');
    nav.className = 'appnav';
    nav.id = 'appnav';
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', 'Pages');
    nav.innerHTML = '<p class="appnav-brand">Mes apports</p>' + PAGES.map(function (p) {
      var cur = p.file === here ? ' aria-current="page"' : '';
      return '<a class="appnav-link" href="' + p.href + '"' + cur + '>' + ICONS[p.icon] + '<span>' + p.label + '</span></a>';
    }).join('');

    var scrim = document.createElement('div');
    scrim.className = 'appnav-scrim';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'appnav-toggle';
    btn.setAttribute('aria-label', 'Ouvrir le menu');
    btn.setAttribute('aria-controls', 'appnav');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = ICONS.menu;

    function setOpen(open) {
      nav.classList.toggle('open', open);
      scrim.classList.toggle('show', open);
      btn.setAttribute('aria-expanded', String(open));
      if (open) { var cur = nav.querySelector('[aria-current]') || nav.querySelector('a'); cur && cur.focus(); }
    }
    btn.addEventListener('click', function () { setOpen(!nav.classList.contains('open')); });
    scrim.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && nav.classList.contains('open')) { setOpen(false); btn.focus(); } });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });

    document.body.appendChild(scrim);
    document.body.appendChild(nav);
    document.body.appendChild(btn);
    document.body.classList.add('appnav-on');
  }

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);
})();
