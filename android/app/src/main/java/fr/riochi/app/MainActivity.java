package fr.riochi.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;
import java.util.Iterator;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // Portrait et paysage suivent le capteur, même quand la rotation automatique du téléphone est coupée.
    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
    getBridge().getWebView().addJavascriptInterface(new RiochiBridge(this), "RiochiNative");
  }

  // Téléchargement d'un épisode (fichier MP4 direct) dans Téléchargements/Riochi, avec les en-têtes du plugin.
  public static class RiochiBridge {
    private final Context context;

    RiochiBridge(Context context) {
      this.context = context;
    }

    @JavascriptInterface
    public String download(String url, String headersJson, String name) {
      try {
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
          return "{\"ok\":false,\"error\":\"adresse invalide\"}";
        }
        String safe = (name == null ? "episode.mp4" : name).replaceAll("[\\\\/:*?\"<>|]+", " ").trim();
        if (safe.isEmpty()) safe = "episode.mp4";
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
        if (headersJson != null && !headersJson.isEmpty()) {
          JSONObject h = new JSONObject(headersJson);
          Iterator<String> it = h.keys();
          while (it.hasNext()) {
            String k = it.next();
            req.addRequestHeader(k, h.optString(k));
          }
        }
        req.setTitle(safe);
        req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Riochi/" + safe);
        ((DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
        return "{\"ok\":true,\"where\":\"Téléchargements/Riochi\"}";
      } catch (Exception e) {
        return "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
      }
    }
  }
}
