package com.example.mini;
import android.app.Activity; import android.os.Bundle; import android.widget.TextView;
public class MainActivity extends Activity {
  @Override protected void onCreate(Bundle b) { super.onCreate(b); TextView t = new TextView(this); t.setText(Greeter.greet("world")); setContentView(t); }
}
