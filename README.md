# DomSlider - DOM Rearranger, Sticky Pin & Sidebar Extension

DomSlider; web sayfalarındaki DOM elementlerini sürükle-bırak yöntemiyle yeniden düzenlemenizi, dilediğiniz elementleri ekran kenarına pinlemenizi (sticky header) ve sağ taraftaki panelde toplamanızı sağlayan Manifest V3 uyumlu bir Chrome uzantısıdır.

## 🌟 Öne Çıkan Özellikler

1. **Çakışmasız İzolasyon (Shadow DOM & Reset):**
   - Sağ panel (sidebar) tamamen `Shadow DOM (open)` içinde render edilir. Sayfanın CSS kuralları veya diğer eklentilerin stilleri paneli bozmaz; panel stilleri de sayfayı etkilemez.
2. **Üst Üste Binmeyen Sürükle-Bırak (DOM Flow Insertion):**
   - Elemanlar mutlak pozisyon (`absolute/fixed`) ile değil, standart DOM akışında (`insertBefore` / `nextSibling`) yer değiştirir.
   - Sürükleme anında hedef elemanın üstünde/altında mavi bir yerleşim çizgisi (**drop indicator**) belirir.
3. **Tek Tıkla Pinleme (Screen Edge Sticky Pin):**
   - Her elemanın üzerine gelindiğinde açılan toolbar veya sidebar listesinden 📌 **Pinle** seçeneği bulunur.
   - Pinlenen eleman ekran kaydırıldığında (`scroll`) sayfanın en üstünde takılı kalarak görünür kalmaya devam eder. Sayfa düzeninin çökmemesi için arkasında görünmez bir placeholder tutulur.
4. **Bağımsız Bölüm Sıfırlama (Reset to Default):**
   - Taşınan, pinlenen veya sağ panele alınan her eleman için orijinal ebeveyn (`parentNode`) ve sıra referansı saklanır.
   - Sidebar'dan veya eleman üzerindeki **↺ Sıfırla** butonuyla dilediğiniz bölümü tek başına varsayılan yerine geri döndürebilirsiniz.
5. **URL Bazlı Kalıcı Hafıza (`chrome.storage.local`):**
   - Yapılan tüm taşımalar, pinler ve dock durumları geçerli sayfanın URL'sine bağlı olarak saklanır. Sayfa yenilendiğinde otomatik olarak tekrar uygulanır.

---

## 🛠️ Kurulum ve Çalıştırma

1. Google Chrome (veya Chromium tabanlı tarayıcınızı - Edge, Brave, Opera) açın.
2. Adres çubuğuna `chrome://extensions` yazıp Enter'a basın.
3. Sağ üst köşedeki **Geliştirici Modu (Developer mode)** anahtarını açın.
4. Sol üstteki **Paketlenmemiş öğe yükle (Load unpacked)** butonuna tıklayın.
5. `/home/zlkrnyn/domslider` klasörünü seçin.
6. Herhangi bir web sayfasına gidin (veya klasördeki `test.html` dosyasını açın) ve sağ taraftaki **◧ DOMSLIDER** kulakçığına tıklayın!
