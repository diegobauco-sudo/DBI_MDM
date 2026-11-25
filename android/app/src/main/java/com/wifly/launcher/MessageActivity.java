package com.wifly.launcher;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.view.View;
import android.widget.TextView;

import java.util.ArrayDeque;

/** Mensaje del administrador sobre cualquier app. Si llegan varios, se muestran en orden. */
public class MessageActivity extends Activity {
    private final ArrayDeque<Intent> queue = new ArrayDeque<Intent>();
    private final Handler handler = new Handler();
    private String currentId;
    private final Runnable next = new Runnable() { @Override public void run() { advance("cerrado automáticamente"); } };

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        setContentView(R.layout.message);
        findViewById(R.id.msg_ok).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { advance("leído por el usuario"); }
        });
        queue.add(getIntent());
        advance(null);
    }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        queue.add(i);
    }

    @Override public void onBackPressed() { advance("leído por el usuario"); }

    private void advance(String closedAs) {
        handler.removeCallbacks(next);
        if (closedAs != null) MdmService.reportAsync(this, currentId, closedAs);
        Intent i = queue.poll();
        if (i == null) {
            finish();
            return;
        }
        currentId = i.getStringExtra("id");
        ((TextView) findViewById(R.id.msg_title)).setText(i.getStringExtra("title"));
        ((TextView) findViewById(R.id.msg_body)).setText(i.getStringExtra("body"));
        findViewById(R.id.msg_ok).requestFocus();
        int seconds = i.getIntExtra("seconds", 0);
        if (seconds > 0) handler.postDelayed(next, seconds * 1000L);
    }

    @Override protected void onDestroy() {
        handler.removeCallbacks(next);
        super.onDestroy();
    }
}
