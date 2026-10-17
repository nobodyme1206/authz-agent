package sample.c07;
import java.security.Principal;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/c07")
public class Controller {
    private Mapper mapper;
    private static final boolean ACTIVE = true;
    @PostMapping("/records")
    public void run(@RequestParam String id, @RequestParam String value, Principal principal) {
        if (ACTIVE) {
            if (!principal.getName().equals(mapper.owner(id))) throw new SecurityException();
        }
        mapper.update(id, value);
    }
}
