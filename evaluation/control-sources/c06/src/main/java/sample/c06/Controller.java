package sample.c06;
import java.security.Principal;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/c06")
public class Controller {
    private Mapper mapper;
    @PostMapping("/records")
    public void run(@RequestParam String id, @RequestParam String value, Principal principal) {
        try {
            if (!principal.getName().equals(mapper.owner(id))) throw new SecurityException();
        } catch (SecurityException ex) {
        }
        mapper.update(id, value);
    }
}
