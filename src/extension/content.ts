// content.js - Runs BEFORE page loads
(function() {
  // Set attribute on documentElement (always exists)
  document.documentElement.setAttribute('sustainable-extension-loaded', 'true');
  console.debug('🌿 Sustainable Browser extension loaded.');
})();