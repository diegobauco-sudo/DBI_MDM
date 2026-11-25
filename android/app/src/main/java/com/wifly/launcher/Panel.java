package com.wifly.launcher;

import android.app.Activity;
import android.content.Context;
import android.text.InputType;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Arma las pantallas de administración, todas con botones aptos para control remoto. */
final class Panel {
    final Activity a;
    final LinearLayout root;

    Panel(Activity a, String heading, String sub) {
        this.a = a;
        a.setContentView(R.layout.panel);
        root = (LinearLayout) a.findViewById(R.id.panel);
        ((TextView) a.findViewById(R.id.heading)).setText(heading);
        subheading(sub);
    }

    void subheading(CharSequence s) {
        TextView t = (TextView) a.findViewById(R.id.subheading);
        t.setText(s);
        t.setVisibility(s == null || s.length() == 0 ? View.GONE : View.VISIBLE);
    }

    Button button(CharSequence text, View.OnClickListener l) {
        Button b = (Button) LayoutInflater.from(a).inflate(R.layout.panel_button, root, false);
        b.setText(text);
        b.setOnClickListener(l);
        root.addView(b);
        return b;
    }

    EditText input(String hint, String value, boolean password) {
        EditText e = (EditText) LayoutInflater.from(a).inflate(R.layout.panel_input, root, false);
        e.setHint(hint);
        if (value != null) e.setText(value);
        e.setInputType(password
            ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD
            : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        root.addView(e);
        return e;
    }

    void clearBelowHeader() {
        while (root.getChildCount() > 2) root.removeViewAt(2);
    }

    static float dp(Context c, float v) { return v * c.getResources().getDisplayMetrics().density; }
}
